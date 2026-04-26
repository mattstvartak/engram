#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Storage } from './storage.js';
import { loadConfig } from './config.js';
import { isLlmAvailable } from './llm.js';
import { search, selectRelevant, formatRecalledMemories } from './search.js';
import { extractFromConversation } from './extractor.js';
import { consolidate } from './consolidator.js';
import { extractRules, formatRulesForPrompt } from './procedural.js';
import { recordRecallOutcome } from './outcome.js';
import { mem0Extract } from './mem0.js';
import { ingest } from './wal.js';
import { readSessionState, updateSessionState, appendToSessionState, clearSessionState, } from './session-state.js';
import { addTriple, replaceTriple, queryGraph, getTimeline, invalidateTriple, getGraphStats, } from './knowledge-graph.js';
import { writeDiaryEntry, readDiary, listDiaryDates } from './diary.js';
import { importConversation } from './importer.js';
import { runGovernanceCheck, detectContradictions } from './governance.js';
import { syncBridge, loadBridgeFile } from './procedural-bridge.js';
import { writeHandoff, readHandoff, listHandoffs } from './handoff.js';
import { assessPressure } from './context-pressure.js';
// ── Config & Storage ────────────────────────────────────────────────
const config = loadConfig();
let _storage = null;
let _storageReady = null;
async function ensureStorage() {
    if (!_storage) {
        _storage = new Storage(config.dataDir);
        _storageReady = _storage.ensureReady();
    }
    await _storageReady;
    return _storage;
}
function text(t) { return { content: [{ type: 'text', text: t }] }; }
function json(data) { return text(JSON.stringify(data, null, 2)); }
// ── MCP Server ──────────────────────────────────────────────────────
const server = new McpServer({ name: 'engram', version: '2.2.0' }, {
    instructions: [
        'Engram is your long-term memory.',
        '',
        'Save what matters: memory_ingest for facts/preferences/decisions, memory_kg_add for relationships, memory_diary_write at session end.',
        'Before answering about prior conversations: memory_search first.',
        '',
        '## Handoff protocol (MANDATORY)',
        'Context compaction can fail if the window fills completely. When that happens, the user has to abandon the chat. Never let this happen.',
        '',
        '1. Save memories continuously with memory_ingest — never batch.',
        '2. At session start, call memory_handoff_read to resume where the prior session left off.',
        '3. When context feels heavy (long tool outputs, many file reads, extended work) call memory_context_pressure with your honest level assessment. Follow the returned actionPlan.',
        '4. At NATURAL PHASE BOUNDARIES (task done, pivoting focus, finishing a subsystem, user says "ok next let\'s…") call memory_context_pressure with phaseBoundary=true and compact. Pivots thrash the cache anyway — compacting at the boundary is a free lunch, carrying verbose tool output from the old phase into the new one is not.',
        '5. BEFORE invoking /compact — or before session end — call memory_handoff_write with a full "where we left off" snapshot: currentTask, completed, nextSteps, openQuestions, fileRefs (path:line), decisions, notes. This is the lifeline if compaction fails.',
        '6. Do not wait for the system to auto-compact. Compact early, while there is still headroom for the handoff.',
        '',
        'If persona MCP available: call persona_signal on user reactions (correction, approval, frustration, praise, etc).',
    ].join('\n'),
});
// ─────────────────────────────────────────────────────────────────────
// CORE MEMORY TOOLS
// ─────────────────────────────────────────────────────────────────────
server.registerTool('memory_search', {
    title: 'Search Memories',
    description: 'Search long-term memories. Returns relevant facts, preferences, decisions, and rules. Set format=true to get pre-formatted output for prompt injection.',
    inputSchema: z.object({
        query: z.string().describe('Natural language search query.'),
        maxResults: z.number().min(1).max(500).optional().describe('Max results (default: 10, max: 500).'),
        domain: z.string().optional().describe('Filter by domain/project.'),
        topic: z.string().optional().describe('Filter by topic.'),
        tag: z.string().optional().describe('Filter by exact tag match. Consumer-defined (e.g. "cortex_type:action_item").'),
        cognitiveLoad: z.enum(['low', 'normal', 'high']).optional().describe('From Persona. "high" returns top 3 only.'),
        format: z.boolean().optional().describe('If true, returns formatted text grouped by cognitive layer instead of JSON.'),
    }),
}, async ({ query, maxResults, domain, topic, tag, cognitiveLoad, format: formatOutput }) => {
    let effectiveMaxResults = maxResults;
    if (cognitiveLoad === 'high') {
        effectiveMaxResults = Math.min(effectiveMaxResults ?? 10, 3);
    }
    const storage = await ensureStorage();
    const results = await search(config, storage, query, effectiveMaxResults, { domain, topic, tag });
    let selected;
    try {
        selected = await selectRelevant(config, query, results);
    }
    catch {
        selected = results.slice(0, cognitiveLoad === 'high' ? 3 : 5);
    }
    if (cognitiveLoad === 'high' && selected.length > 3) {
        selected = selected
            .sort((a, b) => b.chunk.importance - a.chunk.importance)
            .slice(0, 3);
    }
    // Formatted output mode (replaces old memory_format tool)
    if (formatOutput) {
        const memText = formatRecalledMemories(selected);
        const rules = await formatRulesForPrompt(storage);
        return text(memText + rules || 'No relevant memories found.');
    }
    return json({
        total: results.length,
        selected: selected.length,
        results: selected.map(r => ({
            id: r.chunk.id,
            content: r.chunk.content,
            type: r.chunk.type,
            layer: r.chunk.cognitiveLayer,
            tier: r.chunk.tier,
            domain: r.chunk.domain || undefined,
            topic: r.chunk.topic || undefined,
            tags: r.chunk.tags.length > 0 ? r.chunk.tags : undefined,
            source: r.chunk.source || undefined,
            createdAt: r.chunk.createdAt || undefined,
            importance: r.chunk.importance,
            score: Math.round(r.score * 1000) / 1000,
        })),
    });
});
server.registerTool('memory_ingest', {
    title: 'Save Memory',
    description: 'Save a fact, preference, decision, correction, or context to long-term memory. Auto-classifies type/tags if omitted. Auto-checks for duplicates before saving unless skipDedupe=true.',
    inputSchema: z.object({
        content: z.string().describe('The memory to store.'),
        type: z.enum(['fact', 'preference', 'decision', 'context', 'correction']).optional().describe('Memory type.'),
        importance: z.number().min(0).max(1).optional().describe('Importance 0.0-1.0 (default: 0.5).'),
        tags: z.string().optional().describe('Comma-separated tags.'),
        source: z.string().optional().describe('Source identifier (e.g. stable sourceId from an upstream system). Stored on the chunk and returned on search.'),
        domain: z.string().optional().describe('Domain/project namespace.'),
        topic: z.string().optional().describe('Topic within the domain.'),
        sentiment: z.enum(['frustrated', 'curious', 'satisfied', 'neutral', 'excited', 'confused']).optional().describe('Emotional sentiment from Persona.'),
        emotionalValence: z.number().min(-1).max(1).optional().describe('Emotional valence from Persona. Boosts importance for charged memories.'),
        emotionalArousal: z.number().min(0).max(1).optional().describe('Emotional arousal from Persona. High arousal = stronger encoding.'),
        skipDedupe: z.boolean().optional().describe('If true, bypass the 0.75-similarity duplicate check. Use when the caller is writing structured refinements of prior memories (e.g. action items derived from a meeting note) and dedupe would swallow the write.'),
    }),
}, async ({ content, type, importance, tags, source, domain, topic, sentiment, emotionalValence, emotionalArousal, skipDedupe }) => {
    const storage = await ensureStorage();
    // Auto duplicate check (replaces old memory_check_duplicate tool). Callers
    // writing intentional refinements can bypass via skipDedupe=true.
    if (!skipDedupe) {
        const dupeResults = await search(config, storage, content, 5);
        const similar = dupeResults.filter(r => r.score >= 0.75);
        if (similar.length > 0) {
            return json({
                ingested: 0,
                duplicate: true,
                similar: similar.map(r => ({
                    id: r.chunk.id,
                    content: r.chunk.content,
                    score: Math.round(r.score * 1000) / 1000,
                })),
            });
        }
    }
    const chunks = await ingest(config, storage, [{
            content,
            type: type,
            importance,
            tags: tags?.split(',').map(t => t.trim()),
            ...(source ? { source } : {}),
            domain,
            topic,
            sentiment: sentiment,
            emotionalValence,
            emotionalArousal,
        }]);
    return json({
        ingested: chunks.length,
        memory: chunks[0] ? {
            id: chunks[0].id,
            content: chunks[0].content,
            type: chunks[0].type,
            layer: chunks[0].cognitiveLayer,
            domain: chunks[0].domain || undefined,
            topic: chunks[0].topic || undefined,
        } : null,
    });
});
server.registerTool('memory_extract', {
    title: 'Extract Memories',
    description: 'Extract memories from a conversation. Uses LLM or heuristic fallback. Set rulesOnly=true to extract procedural rules only.',
    inputSchema: z.object({
        messages: z.string().describe('JSON string of message array: [{role: "user", content: "..."}, ...]'),
        conversationId: z.string().optional().describe('Session/conversation identifier.'),
        rulesOnly: z.boolean().optional().describe('If true, only extract procedural rules.'),
    }),
}, async ({ messages, conversationId, rulesOnly }) => {
    const storage = await ensureStorage();
    const parsed = JSON.parse(messages);
    const convId = conversationId ?? `mcp-${Date.now()}`;
    // Rules-only mode (replaces old memory_extract_rules tool)
    if (rulesOnly) {
        await extractRules(config, storage, parsed);
        const rules = await formatRulesForPrompt(storage);
        return text(rules || 'No procedural rules extracted.');
    }
    const allChunks = [];
    if (config.extractionProvider === 'local' || config.extractionProvider === 'both') {
        const chunks = await extractFromConversation(config, storage, parsed, convId);
        allChunks.push(...chunks.map(c => ({
            id: c.id, content: c.content, type: c.type,
            layer: c.cognitiveLayer, importance: c.importance,
            source: isLlmAvailable() ? 'llm' : 'heuristic',
        })));
    }
    if (config.extractionProvider === 'mem0' || config.extractionProvider === 'both') {
        const chunks = await mem0Extract(config, storage, parsed, convId);
        allChunks.push(...chunks.map(c => ({
            id: c.id, content: c.content, type: c.type,
            layer: c.cognitiveLayer, importance: c.importance, source: 'mem0',
        })));
    }
    return json({ extracted: allChunks.length, memories: allChunks });
});
server.registerTool('memory_maintain', {
    title: 'Consolidate',
    description: 'Run memory consolidation: decay, promote/demote tiers, link related, merge duplicates, self-organize, and sync Persona bridge.',
    inputSchema: z.object({}),
}, async () => {
    const storage = await ensureStorage();
    const stats = await consolidate(storage, config);
    // Auto-sync procedural bridge during maintenance
    let bridgeSync = { exported: 0, imported: 0, reinforced: 0, conflicts: 0 };
    try {
        bridgeSync = await syncBridge(storage);
    }
    catch {
        // Bridge sync is best-effort
    }
    return json({ action: 'consolidation', ...stats, bridge: bridgeSync });
});
server.registerTool('memory_rules', {
    title: 'Procedural Rules',
    description: 'Show active procedural rules learned from corrections and preferences.',
    inputSchema: z.object({}),
}, async () => {
    const storage = await ensureStorage();
    const t = await formatRulesForPrompt(storage);
    return text(t || 'No active procedural rules.');
});
server.registerTool('memory_outcome', {
    title: 'Recall Outcome',
    description: 'Record whether recalled memories were helpful, corrected, or irrelevant. Adjusts importance.',
    inputSchema: z.object({
        outcome: z.enum(['helpful', 'corrected', 'irrelevant']).describe('Outcome.'),
        chunkIds: z.string().describe('Comma-separated memory chunk IDs.'),
    }),
}, async ({ outcome, chunkIds }) => {
    const storage = await ensureStorage();
    const ids = chunkIds.split(',').map(id => id.trim());
    await recordRecallOutcome(config, storage, ids, outcome, `mcp-${Date.now()}`);
    return text(`Recorded ${outcome} outcome for ${ids.length} chunk(s).`);
});
server.registerTool('memory_session', {
    title: 'Session State',
    description: 'Manage session state (hot RAM). Actions: show, task, context, decision, action, clear.',
    inputSchema: z.object({
        action: z.enum(['show', 'task', 'context', 'decision', 'action', 'clear']).describe('Action.'),
        value: z.string().optional().describe('Value (required for task/context/decision/action).'),
    }),
}, async ({ action, value }) => {
    switch (action) {
        case 'show':
            return json(readSessionState(config.dataDir));
        case 'task':
            updateSessionState(config.dataDir, { currentTask: value ?? '' });
            return text(`Task set: ${value}`);
        case 'context':
            appendToSessionState(config.dataDir, 'keyContext', value ?? '');
            return text(`Context added: ${value}`);
        case 'decision':
            appendToSessionState(config.dataDir, 'recentDecisions', value ?? '');
            return text(`Decision recorded: ${value}`);
        case 'action':
            appendToSessionState(config.dataDir, 'pendingActions', { text: value ?? '', done: false });
            return text(`Action added: ${value}`);
        case 'clear':
            clearSessionState(config.dataDir);
            return text('Session state cleared.');
        default:
            return text(`Unknown action: ${action}`);
    }
});
server.registerTool('memory_stats', {
    title: 'Stats',
    description: 'Memory system stats: chunks by tier/layer/type, rules, knowledge graph, bridge status, and taxonomy.',
    inputSchema: z.object({}),
}, async () => {
    const storage = await ensureStorage();
    const all = await storage.listChunks();
    const tiers = {};
    const layers = {};
    const types = {};
    for (const c of all) {
        tiers[c.tier] = (tiers[c.tier] ?? 0) + 1;
        layers[c.cognitiveLayer] = (layers[c.cognitiveLayer] ?? 0) + 1;
        types[c.type] = (types[c.type] ?? 0) + 1;
    }
    const rules = await storage.getRules();
    const kgStats = await getGraphStats(storage);
    const state = readSessionState(config.dataDir);
    const diaryDates = listDiaryDates(config.dataDir);
    // Taxonomy (folded in from old memory_taxonomy tool)
    const tree = await storage.getTaxonomy();
    // Bridge status (new observability)
    let bridge = { status: 'no bridge file' };
    try {
        const bridgeFile = loadBridgeFile();
        bridge = {
            lastUpdated: bridgeFile.lastUpdated,
            totalRules: bridgeFile.rules.length,
            engramRules: bridgeFile.rules.filter(r => r.source === 'engram').length,
            personaRules: bridgeFile.rules.filter(r => r.source === 'persona').length,
        };
    }
    catch { /* no bridge file */ }
    return json({
        totalChunks: all.length,
        byTier: tiers,
        byLayer: layers,
        byType: types,
        proceduralRules: rules.length,
        activeRules: rules.filter(r => r.confidence > 0.3).length,
        knowledgeGraph: kgStats,
        taxonomy: tree,
        bridge,
        diaryEntries: diaryDates.length,
        llmAvailable: isLlmAvailable(),
        embeddingModel: process.env.ENGRAM_EMBEDDING_MODEL ?? process.env.SMART_MEMORY_EMBEDDING_MODEL ?? 'Xenova/all-MiniLM-L6-v2',
        sessionTask: state.currentTask || null,
    });
});
server.registerTool('memory_govern', {
    title: 'Governance Check',
    description: 'Advisory checks: "check" (contradictions), "drift" (semantic drift), "poison" (injection scan), "full" (all).',
    inputSchema: z.object({
        action: z.enum(['check', 'drift', 'poison', 'full']).describe('Governance action.'),
        content: z.string().optional().describe('Content to check (required for "check").'),
        domain: z.string().optional().describe('Filter by domain.'),
    }),
}, async ({ action, content, domain }) => {
    const storage = await ensureStorage();
    if (action === 'check') {
        if (!content)
            return json({ error: 'Content required for contradiction check.' });
        const result = await detectContradictions(config, storage, content, { domain });
        return json(result);
    }
    if (action === 'full') {
        const report = await runGovernanceCheck(config, storage, { content, domain });
        return json(report);
    }
    if (action === 'drift') {
        const { measureSemanticDrift } = await import('./governance.js');
        const drift = await measureSemanticDrift(config, storage, { domain });
        return json(drift);
    }
    if (action === 'poison') {
        const { checkMemoryPoisoning } = await import('./governance.js');
        const poison = await checkMemoryPoisoning(storage);
        return json(poison);
    }
    return json({ error: 'Unknown action.' });
});
// ─────────────────────────────────────────────────────────────────────
// KNOWLEDGE GRAPH TOOLS
// ─────────────────────────────────────────────────────────────────────
server.registerTool('memory_kg_add', {
    title: 'KG Add',
    description: 'Add a subject-predicate-object triple. Use replace=true to auto-invalidate conflicting facts.',
    inputSchema: z.object({
        subject: z.string().describe('Entity (e.g. "Matt").'),
        predicate: z.string().describe('Relationship (e.g. "works-at").'),
        object: z.string().describe('Target (e.g. "Acme Corp").'),
        replace: z.boolean().optional().describe('Invalidate existing triples with same subject+predicate.'),
        confidence: z.number().min(0).max(1).optional().describe('Confidence 0-1 (default: 0.5).'),
    }),
}, async ({ subject, predicate, object, replace, confidence }) => {
    const storage = await ensureStorage();
    const fn = replace ? replaceTriple : addTriple;
    const triple = await fn(storage, subject, predicate, object, `mcp-${Date.now()}`, confidence);
    return json({ added: true, triple: { id: triple.id, subject: triple.subject, predicate: triple.predicate, object: triple.object } });
});
server.registerTool('memory_kg_query', {
    title: 'KG Query',
    description: 'Query knowledge graph triples. Filter by subject, predicate, and/or object.',
    inputSchema: z.object({
        subject: z.string().optional().describe('Filter by subject.'),
        predicate: z.string().optional().describe('Filter by relationship.'),
        object: z.string().optional().describe('Filter by target.'),
        activeOnly: z.boolean().optional().describe('Only valid facts (default: true).'),
    }),
}, async ({ subject, predicate, object, activeOnly }) => {
    const storage = await ensureStorage();
    const triples = await queryGraph(storage, {
        subject, predicate, object,
        activeOnly: activeOnly ?? true,
    });
    return json({
        count: triples.length,
        triples: triples.map(t => ({
            id: t.id, subject: t.subject, predicate: t.predicate, object: t.object,
            confidence: t.confidence, validFrom: t.validFrom, validTo: t.validTo,
        })),
    });
});
server.registerTool('memory_kg_invalidate', {
    title: 'KG Invalidate',
    description: 'Mark a fact as no longer valid. Stays in history.',
    inputSchema: z.object({
        tripleId: z.string().describe('Triple ID to invalidate.'),
    }),
}, async ({ tripleId }) => {
    const storage = await ensureStorage();
    await invalidateTriple(storage, tripleId);
    return text(`Triple ${tripleId} invalidated.`);
});
server.registerTool('memory_kg_timeline', {
    title: 'KG Timeline',
    description: 'Chronological history of all facts about an entity.',
    inputSchema: z.object({
        entity: z.string().describe('Entity name.'),
    }),
}, async ({ entity }) => {
    const storage = await ensureStorage();
    const timeline = await getTimeline(storage, entity);
    return json({
        entity,
        facts: timeline.map(t => ({
            subject: t.subject, predicate: t.predicate, object: t.object,
            validFrom: t.validFrom, validTo: t.validTo, active: !t.validTo,
        })),
    });
});
// ─────────────────────────────────────────────────────────────────────
// DIARY TOOLS
// ─────────────────────────────────────────────────────────────────────
server.registerTool('memory_diary_write', {
    title: 'Write Diary',
    description: 'Write a session diary entry. Record what happened, what was decided, what matters next.',
    inputSchema: z.object({
        content: z.string().describe('Diary entry.'),
        agent: z.string().optional().describe('Agent name (default: "claude").'),
    }),
}, async ({ content, agent }) => {
    const entry = writeDiaryEntry(config.dataDir, content, agent);
    return json({ written: true, date: entry.date, time: entry.time, agent: entry.agent });
});
server.registerTool('memory_diary_read', {
    title: 'Read Diary',
    description: 'Read diary entries from recent days or a specific date.',
    inputSchema: z.object({
        date: z.string().optional().describe('YYYY-MM-DD. If omitted, returns recent.'),
        daysBack: z.number().optional().describe('Days to look back (default: 7).'),
        agent: z.string().optional().describe('Filter by agent.'),
    }),
}, async ({ date, daysBack, agent }) => {
    const entries = readDiary(config.dataDir, { date, daysBack, agent });
    return json(entries);
});
// ─────────────────────────────────────────────────────────────────────
// HANDOFF TOOLS — cross-session "where we left off" lifeline
// ─────────────────────────────────────────────────────────────────────
server.registerTool('memory_handoff_write', {
    title: 'Write Handoff Note',
    description: 'Write a structured "where we left off" snapshot. Call BEFORE /compact, before session end, or when context_pressure returns hot/critical. This is the lifeline if the context window fills before compaction runs. Fields: currentTask, completed, nextSteps, openQuestions, fileRefs, decisions, notes.',
    inputSchema: z.object({
        currentTask: z.string().describe('One-sentence description of what you are working on.'),
        reason: z.enum(['compact', 'session-end', 'manual', 'context-pressure']).optional().describe('Why this handoff is being written (default: manual).'),
        sessionId: z.string().optional().describe('Session/conversation ID for cross-referencing.'),
        completed: z.string().optional().describe('Comma-separated list of what has been completed this session.'),
        nextSteps: z.string().optional().describe('Comma-separated concrete next actions to take on resume.'),
        openQuestions: z.string().optional().describe('Comma-separated unresolved questions or blockers.'),
        fileRefs: z.string().optional().describe('Comma-separated file paths (ideally path:line) the next agent needs.'),
        decisions: z.string().optional().describe('Comma-separated key decisions made this session.'),
        notes: z.string().optional().describe('Free-form additional context, quirks, gotchas.'),
    }),
}, async ({ currentTask, reason, sessionId, completed, nextSteps, openQuestions, fileRefs, decisions, notes }) => {
    const splitCsv = (s) => s ? s.split(',').map(x => x.trim()).filter(Boolean) : [];
    const note = writeHandoff(config.dataDir, {
        sessionId: sessionId ?? null,
        reason: reason ?? 'manual',
        currentTask,
        completed: splitCsv(completed),
        nextSteps: splitCsv(nextSteps),
        openQuestions: splitCsv(openQuestions),
        fileRefs: splitCsv(fileRefs),
        decisions: splitCsv(decisions),
        notes: notes ?? '',
    });
    return json({
        written: true,
        timestamp: note.timestamp,
        reason: note.reason,
        summary: note.currentTask,
    });
});
server.registerTool('memory_handoff_read', {
    title: 'Read Handoff Note',
    description: 'Read the most recent handoff note (or a specific one by stamp). Call this at the start of every session to resume where the last one left off. Set list=true to get recent handoff stamps instead of a single note.',
    inputSchema: z.object({
        stamp: z.string().optional().describe('Handoff stamp to load (e.g. "2026-04-20_14-32-05"). If omitted, returns the latest.'),
        list: z.boolean().optional().describe('If true, list recent handoff stamps instead of loading a note.'),
        limit: z.number().min(1).max(50).optional().describe('For list mode: max stamps to return (default 10).'),
    }),
}, async ({ stamp, list, limit }) => {
    if (list) {
        return json({ handoffs: listHandoffs(config.dataDir, limit ?? 10) });
    }
    const note = readHandoff(config.dataDir, stamp);
    if (!note) {
        return json({ found: false, message: 'No handoff note available.' });
    }
    return json({ found: true, ...note });
});
server.registerTool('memory_context_pressure', {
    title: 'Context Pressure Check',
    description: 'Self-assess context window pressure and get an action plan. Call periodically during long sessions — especially after big tool outputs, many file reads, or when responses feel sluggish. Levels: ok, warm, hot, critical. Also call with phaseBoundary=true at natural phase boundaries (task complete, pivoting focus, finishing a subsystem) — pivots thrash the cache anyway, so that is the RIGHT moment to compact. Returns an ordered actionPlan telling you exactly what to do (save memories, write handoff, compact).',
    inputSchema: z.object({
        level: z.enum(['ok', 'warm', 'hot', 'critical']).describe('Your honest assessment of current context pressure.'),
        reason: z.string().optional().describe('What triggered this check (e.g. "long file reads", "extended session", "near token limit", "phase complete").'),
        phaseBoundary: z.boolean().optional().describe('True when a task/phase just finished or you are about to pivot focus. Forces the action plan toward a proactive compact, even at ok/warm levels.'),
    }),
}, async ({ level, reason, phaseBoundary }) => {
    return json(assessPressure(level, reason ?? '', phaseBoundary ?? false));
});
// ─────────────────────────────────────────────────────────────────────
// IMPORT
// ─────────────────────────────────────────────────────────────────────
server.registerTool('memory_import', {
    title: 'Import',
    description: 'Bulk import from chat exports: claude-jsonl, chatgpt-json, or plain-text.',
    inputSchema: z.object({
        format: z.enum(['claude-jsonl', 'chatgpt-json', 'plain-text']).describe('Export format.'),
        content: z.string().describe('Raw export content.'),
    }),
}, async ({ format, content }) => {
    const storage = await ensureStorage();
    const result = await importConversation(config, storage, format, content);
    return json(result);
});
// ── Start Server ────────────────────────────────────────────────────
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('Engram MCP server running on stdio');
    console.error(`Data dir: ${config.dataDir}`);
    console.error(`LLM: ${isLlmAvailable() ? 'enabled' : 'disabled (heuristic mode)'}`);
    console.error(`Embeddings: local (${process.env.ENGRAM_EMBEDDING_MODEL ?? process.env.SMART_MEMORY_EMBEDDING_MODEL ?? 'Xenova/all-MiniLM-L6-v2'})`);
    console.error(`Mem0: ${config.mem0ApiKey ? 'enabled' : 'disabled'}`);
}
main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
//# sourceMappingURL=server.js.map