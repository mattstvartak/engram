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
import { mem0Extract, mem0SyncAll } from './mem0.js';
import { ingest } from './wal.js';
import { readSessionState, updateSessionState, appendToSessionState, clearSessionState, } from './session-state.js';
import { addTriple, replaceTriple, queryGraph, getTimeline, invalidateTriple, getGraphStats, } from './knowledge-graph.js';
import { writeDiaryEntry, readDiary, listDiaryDates } from './diary.js';
import { importConversation } from './importer.js';
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
const server = new McpServer({ name: 'engram', version: '2.0.0' }, {
    instructions: [
        'Engram is your long-term memory. Everything you learn about the user, their projects, and their preferences lives here.',
        '',
        'YOUR JOB: Save what matters. When the user tells you something about themselves, their work, or makes a decision — write it down immediately with memory_ingest. Don\'t wait. Don\'t batch. Save it now, before you forget.',
        '',
        'THREE TOOLS YOU SHOULD USE CONSTANTLY:',
        '• memory_ingest — Save a fact, preference, decision, or context. Just pass content — everything else is optional.',
        '• memory_kg_add — Record a relationship between things (e.g., "Matt works-on lulld").',
        '• memory_diary_write — At the end of a session, write what happened in your own words.',
        '',
        'BEFORE ANSWERING about anything from a prior conversation: call memory_search first. Your training data doesn\'t remember — Engram does.',
        '',
        'PERSONA INTEGRATION: If persona MCP is available, proactively call persona_signal on user reactions (correction, approval, frustration, elaboration, simplification, code_accepted, code_rejected, explicit_feedback, style_correction, praise).',
        '',
        'Remember: if you don\'t save it, you\'ll lose it at compaction. Save early, save often.',
    ].join('\n'),
});
// ─────────────────────────────────────────────────────────────────────
// CORE MEMORY TOOLS
// ─────────────────────────────────────────────────────────────────────
server.registerTool('memory_search', {
    title: 'Memory Search',
    description: 'Search long-term memories using hybrid ANN vector + keyword search with spreading activation. Returns relevant facts, preferences, decisions, and procedural rules.',
    inputSchema: z.object({
        query: z.string().describe('Natural language search query.'),
        maxResults: z.number().min(1).max(50).optional().describe('Max results (default: 10).'),
        domain: z.string().optional().describe('Filter by domain/project.'),
        topic: z.string().optional().describe('Filter by topic.'),
        cognitiveLoad: z.enum(['low', 'normal', 'high']).optional().describe('User cognitive load from Persona. "high" reduces results to top 3 high-importance memories. "low" allows full results.'),
    }),
}, async ({ query, maxResults, domain, topic, cognitiveLoad }) => {
    // Cognitive-load gating: overloaded users get fewer, higher-quality results
    let effectiveMaxResults = maxResults;
    if (cognitiveLoad === 'high') {
        effectiveMaxResults = Math.min(effectiveMaxResults ?? 10, 3);
    }
    const storage = await ensureStorage();
    const results = await search(config, storage, query, effectiveMaxResults, { domain, topic });
    let selected;
    try {
        selected = await selectRelevant(config, query, results);
    }
    catch {
        selected = results.slice(0, cognitiveLoad === 'high' ? 3 : 5);
    }
    // Under high cognitive load, prefer high-importance memories
    if (cognitiveLoad === 'high' && selected.length > 3) {
        selected = selected
            .sort((a, b) => b.chunk.importance - a.chunk.importance)
            .slice(0, 3);
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
            importance: r.chunk.importance,
            score: Math.round(r.score * 1000) / 1000,
        })),
    });
});
server.registerTool('memory_format', {
    title: 'Memory Format',
    description: 'Search and format recalled memories for context injection, grouped by cognitive layer.',
    inputSchema: z.object({
        query: z.string().describe('Topic or question to recall memories for.'),
    }),
}, async ({ query }) => {
    const storage = await ensureStorage();
    const results = await search(config, storage, query);
    let selected;
    try {
        selected = await selectRelevant(config, query, results);
    }
    catch {
        selected = results.slice(0, 5);
    }
    const memText = formatRecalledMemories(selected);
    const rules = await formatRulesForPrompt(storage);
    return text(memText + rules || 'No relevant memories found.');
});
server.registerTool('memory_ingest', {
    title: 'Save Memory',
    description: 'Save something you learned to your long-term memory. Use this whenever the user shares a fact, preference, decision, correction, or project context. Just pass the content — type and tags are auto-classified if omitted. Save early, save often.',
    inputSchema: z.object({
        content: z.string().describe('The memory to store.'),
        type: z.enum(['fact', 'preference', 'decision', 'context', 'correction']).optional().describe('Memory type.'),
        importance: z.number().min(0).max(1).optional().describe('Importance 0.0-1.0 (default: 0.5).'),
        tags: z.string().optional().describe('Comma-separated tags.'),
        domain: z.string().optional().describe('Domain/project namespace.'),
        topic: z.string().optional().describe('Topic within the domain.'),
        sentiment: z.enum(['frustrated', 'curious', 'satisfied', 'neutral', 'excited', 'confused']).optional().describe('Emotional sentiment from Persona bridge.'),
        emotionalValence: z.number().min(-1).max(1).optional().describe('Emotional valence -1 (negative) to 1 (positive). From Persona. Boosts importance for emotionally charged memories.'),
        emotionalArousal: z.number().min(0).max(1).optional().describe('Emotional arousal 0-1. From Persona. High-arousal memories get stronger encoding.'),
    }),
}, async ({ content, type, importance, tags, domain, topic, sentiment, emotionalValence, emotionalArousal }) => {
    const storage = await ensureStorage();
    const chunks = await ingest(config, storage, [{
            content,
            type: type,
            importance,
            tags: tags?.split(',').map(t => t.trim()),
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
    title: 'Memory Extract',
    description: 'Extract memories from a conversation. Uses LLM if OPENROUTER_API_KEY is set, otherwise falls back to heuristic extraction. Classifies into facts, preferences, decisions, corrections.',
    inputSchema: z.object({
        messages: z.string().describe('JSON string of message array: [{role: "user", content: "..."}, ...]'),
        conversationId: z.string().optional().describe('Session/conversation identifier.'),
    }),
}, async ({ messages, conversationId }) => {
    const storage = await ensureStorage();
    const parsed = JSON.parse(messages);
    const convId = conversationId ?? `mcp-${Date.now()}`;
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
server.registerTool('memory_check_duplicate', {
    title: 'Check Duplicate',
    description: 'Check if a memory already exists before ingesting. Returns similar existing memories with similarity scores.',
    inputSchema: z.object({
        content: z.string().describe('The memory content to check.'),
        threshold: z.number().min(0).max(1).optional().describe('Similarity threshold (default: 0.75).'),
    }),
}, async ({ content, threshold }) => {
    const storage = await ensureStorage();
    const results = await search(config, storage, content, 5);
    const cutoff = threshold ?? 0.75;
    const similar = results
        .filter(r => r.score >= cutoff)
        .map(r => ({
        id: r.chunk.id,
        content: r.chunk.content,
        type: r.chunk.type,
        score: Math.round(r.score * 1000) / 1000,
    }));
    return json({
        isDuplicate: similar.length > 0,
        similar,
    });
});
server.registerTool('memory_maintain', {
    title: 'Memory Maintain',
    description: 'Run memory consolidation: decay importance, promote/demote tiers, link related memories, merge near-duplicates.',
    inputSchema: z.object({}),
}, async () => {
    const storage = await ensureStorage();
    const stats = await consolidate(storage, config);
    return json({ action: 'consolidation', ...stats });
});
server.registerTool('memory_rules', {
    title: 'Memory Rules',
    description: 'Show active procedural rules learned from user corrections and preferences.',
    inputSchema: z.object({}),
}, async () => {
    const storage = await ensureStorage();
    const t = await formatRulesForPrompt(storage);
    return text(t || 'No active procedural rules.');
});
server.registerTool('memory_outcome', {
    title: 'Memory Outcome',
    description: 'Record whether recalled memories were helpful, corrected, or irrelevant. Adjusts importance and strengthens graph edges.',
    inputSchema: z.object({
        outcome: z.enum(['helpful', 'corrected', 'irrelevant']).describe('Outcome of the recalled memories.'),
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
        action: z.enum(['show', 'task', 'context', 'decision', 'action', 'clear']).describe('Action to perform.'),
        value: z.string().optional().describe('Value for the action (required for task/context/decision/action).'),
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
    title: 'Memory Stats',
    description: 'Show memory statistics: chunk counts by tier/layer/type, rule counts, knowledge graph stats.',
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
    const kgStats = await storage.getTripleStats();
    const state = readSessionState(config.dataDir);
    const diaryDates = listDiaryDates(config.dataDir);
    return json({
        totalChunks: all.length,
        byTier: tiers,
        byLayer: layers,
        byType: types,
        proceduralRules: rules.length,
        activeRules: rules.filter(r => r.confidence > 0.3).length,
        knowledgeGraph: kgStats,
        diaryEntries: diaryDates.length,
        llmAvailable: isLlmAvailable(),
        extractionMode: isLlmAvailable() ? 'llm' : 'heuristic',
        embeddingModel: process.env.ENGRAM_EMBEDDING_MODEL ?? process.env.SMART_MEMORY_EMBEDDING_MODEL ?? 'Xenova/all-MiniLM-L6-v2',
        mem0Enabled: !!config.mem0ApiKey,
        sessionTask: state.currentTask || null,
        _reminder: 'Remember: save user facts immediately with memory_ingest. Record relationships with memory_kg_add. Write your diary at session end with memory_diary_write. Don\'t wait — save now.',
    });
});
server.registerTool('memory_taxonomy', {
    title: 'Memory Taxonomy',
    description: 'Show the domain/topic hierarchy with memory counts. Use to understand how memories are organized.',
    inputSchema: z.object({}),
}, async () => {
    const storage = await ensureStorage();
    const tree = await storage.getTaxonomy();
    return json(tree);
});
// ─────────────────────────────────────────────────────────────────────
// KNOWLEDGE GRAPH TOOLS
// ─────────────────────────────────────────────────────────────────────
server.registerTool('memory_kg_add', {
    title: 'Knowledge Graph Add',
    description: 'Add a fact to the knowledge graph as a subject-predicate-object triple. e.g. ("Matt", "works-at", "Acme Corp"). Use replace=true to auto-invalidate conflicting facts.',
    inputSchema: z.object({
        subject: z.string().describe('The entity (e.g. "Matt", "finch-core").'),
        predicate: z.string().describe('The relationship (e.g. "works-at", "uses", "depends-on").'),
        object: z.string().describe('The target (e.g. "Acme Corp", "TypeScript").'),
        replace: z.boolean().optional().describe('If true, invalidate existing triples with the same subject+predicate.'),
        confidence: z.number().min(0).max(1).optional().describe('Confidence 0.0-1.0 (default: 0.5).'),
    }),
}, async ({ subject, predicate, object, replace, confidence }) => {
    const storage = await ensureStorage();
    const fn = replace ? replaceTriple : addTriple;
    const triple = await fn(storage, subject, predicate, object, `mcp-${Date.now()}`, confidence);
    return json({ added: true, triple: { id: triple.id, subject: triple.subject, predicate: triple.predicate, object: triple.object } });
});
server.registerTool('memory_kg_query', {
    title: 'Knowledge Graph Query',
    description: 'Query the knowledge graph. Filter by subject, predicate, and/or object. Set activeOnly=true to exclude invalidated facts.',
    inputSchema: z.object({
        subject: z.string().optional().describe('Filter by subject entity.'),
        predicate: z.string().optional().describe('Filter by relationship type.'),
        object: z.string().optional().describe('Filter by target entity.'),
        activeOnly: z.boolean().optional().describe('Only return currently valid facts (default: true).'),
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
            id: t.id,
            subject: t.subject,
            predicate: t.predicate,
            object: t.object,
            confidence: t.confidence,
            validFrom: t.validFrom,
            validTo: t.validTo,
        })),
    });
});
server.registerTool('memory_kg_invalidate', {
    title: 'Knowledge Graph Invalidate',
    description: 'Mark a knowledge graph fact as no longer valid. The fact remains in history but is excluded from active queries.',
    inputSchema: z.object({
        tripleId: z.string().describe('The triple ID to invalidate.'),
    }),
}, async ({ tripleId }) => {
    const storage = await ensureStorage();
    await invalidateTriple(storage, tripleId);
    return text(`Triple ${tripleId} invalidated.`);
});
server.registerTool('memory_kg_timeline', {
    title: 'Knowledge Graph Timeline',
    description: 'Get the chronological timeline of all facts about an entity, including invalidated ones.',
    inputSchema: z.object({
        entity: z.string().describe('The entity name to get the timeline for.'),
    }),
}, async ({ entity }) => {
    const storage = await ensureStorage();
    const timeline = await getTimeline(storage, entity);
    return json({
        entity,
        facts: timeline.map(t => ({
            subject: t.subject,
            predicate: t.predicate,
            object: t.object,
            validFrom: t.validFrom,
            validTo: t.validTo,
            active: !t.validTo,
        })),
    });
});
server.registerTool('memory_kg_stats', {
    title: 'Knowledge Graph Stats',
    description: 'Show knowledge graph statistics.',
    inputSchema: z.object({}),
}, async () => {
    const storage = await ensureStorage();
    return json(await getGraphStats(storage));
});
// ─────────────────────────────────────────────────────────────────────
// DIARY TOOLS
// ─────────────────────────────────────────────────────────────────────
server.registerTool('memory_diary_write', {
    title: 'Write Your Diary',
    description: 'Write to your personal session diary. Record what you worked on, what was decided, what matters for next time. Write in your own voice — this is your journal, not a log file.',
    inputSchema: z.object({
        content: z.string().describe('The diary entry content.'),
        agent: z.string().optional().describe('Agent name (default: "claude").'),
    }),
}, async ({ content, agent }) => {
    const entry = writeDiaryEntry(config.dataDir, content, agent);
    return json({ written: true, date: entry.date, time: entry.time, agent: entry.agent });
});
server.registerTool('memory_diary_read', {
    title: 'Diary Read',
    description: 'Read diary entries. Returns entries from recent days or a specific date.',
    inputSchema: z.object({
        date: z.string().optional().describe('Specific date (YYYY-MM-DD). If omitted, returns recent entries.'),
        daysBack: z.number().optional().describe('Number of days to look back (default: 7).'),
        agent: z.string().optional().describe('Filter by agent name.'),
    }),
}, async ({ date, daysBack, agent }) => {
    const entries = readDiary(config.dataDir, { date, daysBack, agent });
    return json(entries);
});
// ─────────────────────────────────────────────────────────────────────
// IMPORT / EXTRACTION TOOLS
// ─────────────────────────────────────────────────────────────────────
server.registerTool('memory_import', {
    title: 'Import Conversations',
    description: 'Bulk import conversations from chat exports. Supported formats: claude-jsonl (Claude Code JSONL), chatgpt-json (ChatGPT export), plain-text (user:/assistant: format).',
    inputSchema: z.object({
        format: z.enum(['claude-jsonl', 'chatgpt-json', 'plain-text']).describe('The export format.'),
        content: z.string().describe('The raw export content (JSONL string, JSON string, or plain text).'),
    }),
}, async ({ format, content }) => {
    const storage = await ensureStorage();
    const result = await importConversation(config, storage, format, content);
    return json(result);
});
server.registerTool('memory_extract_rules', {
    title: 'Extract Procedural Rules',
    description: 'Analyze a conversation to extract procedural rules. Works with LLM or heuristic extraction.',
    inputSchema: z.object({
        messages: z.string().describe('JSON string of message array: [{role: "user", content: "..."}, ...]'),
    }),
}, async ({ messages }) => {
    const storage = await ensureStorage();
    const parsed = JSON.parse(messages);
    await extractRules(config, storage, parsed);
    const rules = await formatRulesForPrompt(storage);
    return text(rules || 'No procedural rules extracted.');
});
server.registerTool('memory_mem0_sync', {
    title: 'Mem0 Sync',
    description: 'Sync all memories from Mem0 cloud to local store. Requires MEM0_API_KEY.',
    inputSchema: z.object({}),
}, async () => {
    const storage = await ensureStorage();
    const count = await mem0SyncAll(config, storage);
    return text(`Synced ${count} new memories from Mem0 cloud.`);
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