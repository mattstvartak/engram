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
import {
  readSessionState,
  updateSessionState,
  appendToSessionState,
  clearSessionState,
} from './session-state.js';
import {
  addTriple,
  replaceTriple,
  queryGraph,
  getTimeline,
  invalidateTriple,
  getGraphStats,
} from './knowledge-graph.js';
import { writeDiaryEntry, readDiary, listDiaryDates } from './diary.js';
import { importConversation, type ImportFormat } from './importer.js';

// ── Config & Storage ────────────────────────────────────────────────

const config = loadConfig();

let _storage: Storage | null = null;
let _storageReady: Promise<void> | null = null;

async function ensureStorage(): Promise<Storage> {
  if (!_storage) {
    _storage = new Storage(config.dataDir);
    _storageReady = _storage.ensureReady();
  }
  await _storageReady;
  return _storage;
}

function text(t: string) { return { content: [{ type: 'text' as const, text: t }] }; }
function json(data: any) { return text(JSON.stringify(data, null, 2)); }

// ── MCP Server ──────────────────────────────────────────────────────

const server = new McpServer(
  { name: 'engram', version: '2.0.0' },
  {
    instructions: [
      'Engram MCP server with hybrid vector search, tier lifecycle, spreading activation, procedural rules, knowledge graph, and agent diary.',
      '',
      'PROACTIVE STORAGE (critical -- do not wait to be asked):',
      'When the user shares personal details, professional background, preferences, decisions, corrections, project context, or any fact worth recalling in future conversations, IMMEDIATELY store it using memory_ingest and/or memory_kg_add before responding.',
      'This includes information from documents the user shares (resumes, specs, notes), not just typed messages.',
      'If the user tells you something about who they are, what they do, what they like or dislike, or what they are working on -- store it. Do not assume you will remember it without writing it down.',
      '',
      'ANSWER AND RESEARCH STORAGE:',
      'After answering a user question or performing research, store a concise summary of your response using memory_ingest. This applies to all substantive answers -- career advice, technical explanations, research findings, recommendations, analysis, etc.',
      'Skip storage only for trivial or throwaway exchanges (e.g. "what time is it", "thanks", single-word clarifications) that would waste tokens on recall.',
      'This allows the user to reference prior answers and research in future conversations without repeating the question. Tag memories with relevant topics so they are retrievable later.',
      'Focus on storing conclusions, key data points, and actionable insights -- not verbose reproductions of the full response.',
      '',
      'PROACTIVE RECALL:',
      'Before answering anything about prior work, decisions, dates, people, preferences, or todos: use memory_search to find relevant memories.',
      '',
      'PERSONA INTEGRATION (if the persona MCP server is available):',
      'You MUST proactively record behavioral signals using persona_signal as you observe them. Do not wait to be asked. This is how the persona system learns the user\'s communication preferences over time.',
      '',
      'Record a persona_signal for each of these events:',
      '- "correction": The user corrects your approach, tone, format, or answer (e.g. "no, not like that", "too verbose", "I meant...")',
      '- "approval": The user accepts a non-obvious approach or confirms your direction (e.g. "yes exactly", "perfect", accepting an unusual choice)',
      '- "frustration": The user shows impatience or dissatisfaction (e.g. "I already said...", "why did you...", repeating themselves)',
      '- "elaboration": The user asks you to expand or go deeper -- signals they want more detail in this context',
      '- "simplification": The user asks you to simplify or shorten -- signals they want less detail in this context',
      '- "code_accepted": The user uses your code as-is or with minor tweaks',
      '- "code_rejected": The user discards your code or rewrites it substantially',
      '- "explicit_feedback": The user directly tells you how to behave (e.g. "always do X", "never do Y", "I prefer...")',
      '- "style_correction": The user corrects formatting, tone, or communication style specifically',
      '- "praise": The user expresses genuine satisfaction (e.g. "nice", "that\'s exactly what I needed", "good call")',
      '',
      'Include a descriptive content string and category (e.g. "code", "communication", "research", "career", "workflow") so the persona system can build topic-specific adaptations.',
      '',
      'At the start of complex or multi-step interactions, call persona_context to calibrate your response style to what the user prefers.',
      'Periodically (every 5-10 substantive exchanges), call persona_synthesize with recent user messages to let the system detect communication patterns you may have missed.',
      '',
      'TOOLS:',
      'Use memory_ingest to immediately save important facts, preferences, decisions, or corrections -- write before responding (WAL principle).',
      'Use memory_kg_add to record entity relationships (e.g. "Matt works-at Acme", "project uses TypeScript").',
      'Use memory_diary_write at the end of significant sessions to record what happened.',
      '',
      'SLASH COMMANDS (user-invocable):',
      'These commands work as /command in any compatible client. When the user types one, follow the instructions below.',
      '',
      '/memory-source <engram|off|hybrid> -- Switch memory backend. "engram" = exclusive Engram MCP, "off" = no persistent memory, "hybrid" = Engram + native client memory (default).',
      '/recall <query> -- Search memories using the full hybrid pipeline. Present results conversationally, not as raw data.',
      '/forget <what> -- Find and remove or correct specific memories. Always confirm with user before acting. Use memory_outcome with "irrelevant" to demote, memory_kg_invalidate for wrong facts.',
      '/memory-health [maintain] -- Show memory stats (tiers, layers, rules, KG size). With "maintain" arg, run the consolidation cycle.',
      '/knowledge <subcommand> -- Knowledge graph operations: "timeline <entity>", "about <entity>", "add <s> <p> <o>", "correct <s> <p>", "stats".',
      '/memory <subcommand> -- Quick ops: "save <content>", "diary [date]", "diary write <entry>", "import <source>", "rules", "session [show|clear]".',
    ].join('\n'),
  }
);

// ─────────────────────────────────────────────────────────────────────
// CORE MEMORY TOOLS
// ─────────────────────────────────────────────────────────────────────

server.registerTool(
  'memory_search',
  {
    title: 'Memory Search',
    description: 'Search long-term memories using hybrid ANN vector + keyword search with spreading activation. Returns relevant facts, preferences, decisions, and procedural rules.',
    inputSchema: z.object({
      query: z.string().describe('Natural language search query.'),
      maxResults: z.number().min(1).max(50).optional().describe('Max results (default: 10).'),
      domain: z.string().optional().describe('Filter by domain/project.'),
      topic: z.string().optional().describe('Filter by topic.'),
    }),
  },
  async ({ query, maxResults, domain, topic }) => {
    const storage = await ensureStorage();
    const results = await search(config, storage, query, maxResults, { domain, topic });
    let selected: typeof results;
    try {
      selected = await selectRelevant(config, query, results);
    } catch {
      selected = results.slice(0, 5);
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
  }
);

server.registerTool(
  'memory_format',
  {
    title: 'Memory Format',
    description: 'Search and format recalled memories for context injection, grouped by cognitive layer.',
    inputSchema: z.object({
      query: z.string().describe('Topic or question to recall memories for.'),
    }),
  },
  async ({ query }) => {
    const storage = await ensureStorage();
    const results = await search(config, storage, query);
    let selected: typeof results;
    try {
      selected = await selectRelevant(config, query, results);
    } catch {
      selected = results.slice(0, 5);
    }
    const memText = formatRecalledMemories(selected);
    const rules = await formatRulesForPrompt(storage);
    return text(memText + rules || 'No relevant memories found.');
  }
);

server.registerTool(
  'memory_ingest',
  {
    title: 'Memory Ingest (WAL)',
    description: 'Write-ahead log: immediately persist a memory BEFORE responding. Use when the user states a preference, makes a decision, corrects you, or shares an important fact.',
    inputSchema: z.object({
      content: z.string().describe('The memory to store.'),
      type: z.enum(['fact', 'preference', 'decision', 'context', 'correction']).optional().describe('Memory type.'),
      importance: z.number().min(0).max(1).optional().describe('Importance 0.0-1.0 (default: 0.5).'),
      tags: z.string().optional().describe('Comma-separated tags.'),
      domain: z.string().optional().describe('Domain/project namespace.'),
      topic: z.string().optional().describe('Topic within the domain.'),
    }),
  },
  async ({ content, type, importance, tags, domain, topic }) => {
    const storage = await ensureStorage();
    const chunks = await ingest(config, storage, [{
      content,
      type: type as any,
      importance,
      tags: tags?.split(',').map(t => t.trim()),
      domain,
      topic,
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
  }
);

server.registerTool(
  'memory_extract',
  {
    title: 'Memory Extract',
    description: 'Extract memories from a conversation. Uses LLM if OPENROUTER_API_KEY is set, otherwise falls back to heuristic extraction. Classifies into facts, preferences, decisions, corrections.',
    inputSchema: z.object({
      messages: z.string().describe('JSON string of message array: [{role: "user", content: "..."}, ...]'),
      conversationId: z.string().optional().describe('Session/conversation identifier.'),
    }),
  },
  async ({ messages, conversationId }) => {
    const storage = await ensureStorage();
    const parsed = JSON.parse(messages);
    const convId = conversationId ?? `mcp-${Date.now()}`;
    const allChunks: any[] = [];

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
  }
);

server.registerTool(
  'memory_check_duplicate',
  {
    title: 'Check Duplicate',
    description: 'Check if a memory already exists before ingesting. Returns similar existing memories with similarity scores.',
    inputSchema: z.object({
      content: z.string().describe('The memory content to check.'),
      threshold: z.number().min(0).max(1).optional().describe('Similarity threshold (default: 0.75).'),
    }),
  },
  async ({ content, threshold }) => {
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
  }
);

server.registerTool(
  'memory_maintain',
  {
    title: 'Memory Maintain',
    description: 'Run memory consolidation: decay importance, promote/demote tiers, link related memories, merge near-duplicates.',
    inputSchema: z.object({}),
  },
  async () => {
    const storage = await ensureStorage();
    const stats = await consolidate(storage, config);
    return json({ action: 'consolidation', ...stats });
  }
);

server.registerTool(
  'memory_rules',
  {
    title: 'Memory Rules',
    description: 'Show active procedural rules learned from user corrections and preferences.',
    inputSchema: z.object({}),
  },
  async () => {
    const storage = await ensureStorage();
    const t = await formatRulesForPrompt(storage);
    return text(t || 'No active procedural rules.');
  }
);

server.registerTool(
  'memory_outcome',
  {
    title: 'Memory Outcome',
    description: 'Record whether recalled memories were helpful, corrected, or irrelevant. Adjusts importance and strengthens graph edges.',
    inputSchema: z.object({
      outcome: z.enum(['helpful', 'corrected', 'irrelevant']).describe('Outcome of the recalled memories.'),
      chunkIds: z.string().describe('Comma-separated memory chunk IDs.'),
    }),
  },
  async ({ outcome, chunkIds }) => {
    const storage = await ensureStorage();
    const ids = chunkIds.split(',').map(id => id.trim());
    await recordRecallOutcome(config, storage, ids, outcome, `mcp-${Date.now()}`);
    return text(`Recorded ${outcome} outcome for ${ids.length} chunk(s).`);
  }
);

server.registerTool(
  'memory_session',
  {
    title: 'Session State',
    description: 'Manage session state (hot RAM). Actions: show, task, context, decision, action, clear.',
    inputSchema: z.object({
      action: z.enum(['show', 'task', 'context', 'decision', 'action', 'clear']).describe('Action to perform.'),
      value: z.string().optional().describe('Value for the action (required for task/context/decision/action).'),
    }),
  },
  async ({ action, value }) => {
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
  }
);

server.registerTool(
  'memory_stats',
  {
    title: 'Memory Stats',
    description: 'Show memory statistics: chunk counts by tier/layer/type, rule counts, knowledge graph stats.',
    inputSchema: z.object({}),
  },
  async () => {
    const storage = await ensureStorage();
    const all = await storage.listChunks();
    const tiers: Record<string, number> = {};
    const layers: Record<string, number> = {};
    const types: Record<string, number> = {};
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
    });
  }
);

server.registerTool(
  'memory_taxonomy',
  {
    title: 'Memory Taxonomy',
    description: 'Show the domain/topic hierarchy with memory counts. Use to understand how memories are organized.',
    inputSchema: z.object({}),
  },
  async () => {
    const storage = await ensureStorage();
    const tree = await storage.getTaxonomy();
    return json(tree);
  }
);

// ─────────────────────────────────────────────────────────────────────
// KNOWLEDGE GRAPH TOOLS
// ─────────────────────────────────────────────────────────────────────

server.registerTool(
  'memory_kg_add',
  {
    title: 'Knowledge Graph Add',
    description: 'Add a fact to the knowledge graph as a subject-predicate-object triple. e.g. ("Matt", "works-at", "Acme Corp"). Use replace=true to auto-invalidate conflicting facts.',
    inputSchema: z.object({
      subject: z.string().describe('The entity (e.g. "Matt", "finch-core").'),
      predicate: z.string().describe('The relationship (e.g. "works-at", "uses", "depends-on").'),
      object: z.string().describe('The target (e.g. "Acme Corp", "TypeScript").'),
      replace: z.boolean().optional().describe('If true, invalidate existing triples with the same subject+predicate.'),
      confidence: z.number().min(0).max(1).optional().describe('Confidence 0.0-1.0 (default: 0.5).'),
    }),
  },
  async ({ subject, predicate, object, replace, confidence }) => {
    const storage = await ensureStorage();
    const fn = replace ? replaceTriple : addTriple;
    const triple = await fn(storage, subject, predicate, object, `mcp-${Date.now()}`, confidence);
    return json({ added: true, triple: { id: triple.id, subject: triple.subject, predicate: triple.predicate, object: triple.object } });
  }
);

server.registerTool(
  'memory_kg_query',
  {
    title: 'Knowledge Graph Query',
    description: 'Query the knowledge graph. Filter by subject, predicate, and/or object. Set activeOnly=true to exclude invalidated facts.',
    inputSchema: z.object({
      subject: z.string().optional().describe('Filter by subject entity.'),
      predicate: z.string().optional().describe('Filter by relationship type.'),
      object: z.string().optional().describe('Filter by target entity.'),
      activeOnly: z.boolean().optional().describe('Only return currently valid facts (default: true).'),
    }),
  },
  async ({ subject, predicate, object, activeOnly }) => {
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
  }
);

server.registerTool(
  'memory_kg_invalidate',
  {
    title: 'Knowledge Graph Invalidate',
    description: 'Mark a knowledge graph fact as no longer valid. The fact remains in history but is excluded from active queries.',
    inputSchema: z.object({
      tripleId: z.string().describe('The triple ID to invalidate.'),
    }),
  },
  async ({ tripleId }) => {
    const storage = await ensureStorage();
    await invalidateTriple(storage, tripleId);
    return text(`Triple ${tripleId} invalidated.`);
  }
);

server.registerTool(
  'memory_kg_timeline',
  {
    title: 'Knowledge Graph Timeline',
    description: 'Get the chronological timeline of all facts about an entity, including invalidated ones.',
    inputSchema: z.object({
      entity: z.string().describe('The entity name to get the timeline for.'),
    }),
  },
  async ({ entity }) => {
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
  }
);

server.registerTool(
  'memory_kg_stats',
  {
    title: 'Knowledge Graph Stats',
    description: 'Show knowledge graph statistics.',
    inputSchema: z.object({}),
  },
  async () => {
    const storage = await ensureStorage();
    return json(await getGraphStats(storage));
  }
);

// ─────────────────────────────────────────────────────────────────────
// DIARY TOOLS
// ─────────────────────────────────────────────────────────────────────

server.registerTool(
  'memory_diary_write',
  {
    title: 'Diary Write',
    description: 'Write a diary entry. Use at the end of significant sessions to record what happened, decisions made, and context for future sessions.',
    inputSchema: z.object({
      content: z.string().describe('The diary entry content.'),
      agent: z.string().optional().describe('Agent name (default: "claude").'),
    }),
  },
  async ({ content, agent }) => {
    const entry = writeDiaryEntry(config.dataDir, content, agent);
    return json({ written: true, date: entry.date, time: entry.time, agent: entry.agent });
  }
);

server.registerTool(
  'memory_diary_read',
  {
    title: 'Diary Read',
    description: 'Read diary entries. Returns entries from recent days or a specific date.',
    inputSchema: z.object({
      date: z.string().optional().describe('Specific date (YYYY-MM-DD). If omitted, returns recent entries.'),
      daysBack: z.number().optional().describe('Number of days to look back (default: 7).'),
      agent: z.string().optional().describe('Filter by agent name.'),
    }),
  },
  async ({ date, daysBack, agent }) => {
    const entries = readDiary(config.dataDir, { date, daysBack, agent });
    return json(entries);
  }
);

// ─────────────────────────────────────────────────────────────────────
// IMPORT / EXTRACTION TOOLS
// ─────────────────────────────────────────────────────────────────────

server.registerTool(
  'memory_import',
  {
    title: 'Import Conversations',
    description: 'Bulk import conversations from chat exports. Supported formats: claude-jsonl (Claude Code JSONL), chatgpt-json (ChatGPT export), plain-text (user:/assistant: format).',
    inputSchema: z.object({
      format: z.enum(['claude-jsonl', 'chatgpt-json', 'plain-text']).describe('The export format.'),
      content: z.string().describe('The raw export content (JSONL string, JSON string, or plain text).'),
    }),
  },
  async ({ format, content }) => {
    const storage = await ensureStorage();
    const result = await importConversation(config, storage, format as ImportFormat, content);
    return json(result);
  }
);

server.registerTool(
  'memory_extract_rules',
  {
    title: 'Extract Procedural Rules',
    description: 'Analyze a conversation to extract procedural rules. Works with LLM or heuristic extraction.',
    inputSchema: z.object({
      messages: z.string().describe('JSON string of message array: [{role: "user", content: "..."}, ...]'),
    }),
  },
  async ({ messages }) => {
    const storage = await ensureStorage();
    const parsed = JSON.parse(messages);
    await extractRules(config, storage, parsed);
    const rules = await formatRulesForPrompt(storage);
    return text(rules || 'No procedural rules extracted.');
  }
);

server.registerTool(
  'memory_mem0_sync',
  {
    title: 'Mem0 Sync',
    description: 'Sync all memories from Mem0 cloud to local store. Requires MEM0_API_KEY.',
    inputSchema: z.object({}),
  },
  async () => {
    const storage = await ensureStorage();
    const count = await mem0SyncAll(config, storage);
    return text(`Synced ${count} new memories from Mem0 cloud.`);
  }
);

// ── Start Server ────────────────────────────────────────────────────

async function main(): Promise<void> {
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
