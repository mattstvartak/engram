#!/usr/bin/env node
/**
 * Engram CLI router.
 *
 * Usage:
 *   engram-mcp                                                 → run MCP stdio server (back-compat)
 *   engram-mcp search --query <q> [--project <p>] [--limit N]
 *                     [--min-relevance F] [--format json|text]
 *   engram-mcp query  [--project <p>] [--tier <t>]
 *                     [--min-importance F] [--limit N] [--format json|text]
 *   engram-mcp help
 *
 * The CLI is additive — it wraps the same search/storage primitives the
 * MCP server uses so hook scripts can pull memories without speaking
 * stdio JSON-RPC.
 */
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { Storage } from './storage.js';
import { search, formatRecalledMemories } from './search.js';
const HELP = `engram-mcp — memory CLI

Usage:
  engram-mcp                                              run MCP stdio server
  engram-mcp search  --query <q> [opts]                   hybrid search
  engram-mcp query   [opts]                               filter listing
  engram-mcp help                                         this message

search options:
  --query <q>            (required) natural-language query
  --project <p>          filter by domain (project namespace)
  --topic <t>            filter by topic
  --tag <t>              filter by exact tag
  --limit <n>            max results (default 10)
  --min-relevance <f>    drop results with score < f (0..1)
  --format json|text     output mode (default json)
  --no-embed             skip embedding model load (keyword/IDF only,
                         ~1.5s faster cold-start, lower recall)

query options:
  --project <p>          filter by domain
  --topic <t>            filter by topic
  --tag <t>              filter by exact tag
  --tier <t>             daily | short-term | long-term | archive
  --layer <l>            episodic | semantic | procedural
  --min-importance <f>   drop chunks with importance < f (0..1)
  --limit <n>            max results (default 25)
  --format json|text     output mode (default json)

Environment:
  ENGRAM_DATA_DIR        data directory (default ~/.claude/engram)
`;
const SEARCH_OPTS = {
    query: { type: 'string' },
    project: { type: 'string' },
    topic: { type: 'string' },
    tag: { type: 'string' },
    limit: { type: 'string' },
    'min-relevance': { type: 'string' },
    format: { type: 'string' },
    'no-embed': { type: 'boolean' },
};
const QUERY_OPTS = {
    project: { type: 'string' },
    topic: { type: 'string' },
    tag: { type: 'string' },
    tier: { type: 'string' },
    layer: { type: 'string' },
    'min-importance': { type: 'string' },
    limit: { type: 'string' },
    format: { type: 'string' },
};
function parseFloatOpt(v, name) {
    if (v === undefined)
        return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) {
        fail(`--${name} must be a number, got "${v}"`);
    }
    return n;
}
function parseIntOpt(v, name) {
    if (v === undefined)
        return undefined;
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n < 0) {
        fail(`--${name} must be a non-negative integer, got "${v}"`);
    }
    return n;
}
function parseFormat(v) {
    if (v === undefined)
        return 'json';
    if (v !== 'json' && v !== 'text')
        fail(`--format must be json|text, got "${v}"`);
    return v;
}
function parseTier(v) {
    if (v === undefined)
        return undefined;
    const allowed = ['daily', 'short-term', 'long-term', 'archive'];
    if (!allowed.includes(v)) {
        fail(`--tier must be one of ${allowed.join('|')}, got "${v}"`);
    }
    return v;
}
function fail(msg) {
    process.stderr.write(`engram-mcp: ${msg}\n`);
    process.exit(2);
}
function chunkToWire(c) {
    return {
        id: c.id,
        content: c.content,
        type: c.type,
        layer: c.cognitiveLayer,
        tier: c.tier,
        domain: c.domain || undefined,
        topic: c.topic || undefined,
        tags: c.tags.length > 0 ? c.tags : undefined,
        source: c.source || undefined,
        importance: c.importance,
        createdAt: c.createdAt || undefined,
    };
}
async function runSearch(argv) {
    const { values } = parseArgs({ args: argv, options: SEARCH_OPTS, allowPositionals: false });
    if (!values.query)
        fail('search: --query is required');
    const limit = parseIntOpt(values.limit, 'limit') ?? 10;
    const minRelevance = parseFloatOpt(values['min-relevance'], 'min-relevance') ?? 0;
    const format = parseFormat(values.format);
    if (values['no-embed']) {
        process.env.ENGRAM_SKIP_EMBED = '1';
    }
    const config = loadConfig();
    const storage = new Storage(config.dataDir);
    await storage.ensureReady();
    const filters = {};
    if (values.project)
        filters.domain = values.project;
    if (values.topic)
        filters.topic = values.topic;
    if (values.tag)
        filters.tag = values.tag;
    let results = [];
    try {
        results = await search(config, storage, values.query, limit, filters);
    }
    catch (err) {
        fail(`search failed: ${err.message}`);
    }
    const filtered = results.filter(r => r.score >= minRelevance).slice(0, limit);
    if (format === 'text') {
        process.stdout.write(formatRecalledMemories(filtered));
        return;
    }
    process.stdout.write(JSON.stringify({
        total: results.length,
        returned: filtered.length,
        results: filtered.map(r => ({
            ...chunkToWire(r.chunk),
            score: Math.round(r.score * 1000) / 1000,
        })),
    }, null, 2) + '\n');
}
async function runQuery(argv) {
    const { values } = parseArgs({ args: argv, options: QUERY_OPTS, allowPositionals: false });
    const limit = parseIntOpt(values.limit, 'limit') ?? 25;
    const minImportance = parseFloatOpt(values['min-importance'], 'min-importance') ?? 0;
    const format = parseFormat(values.format);
    const tier = parseTier(values.tier);
    const config = loadConfig();
    const storage = new Storage(config.dataDir);
    await storage.ensureReady();
    const opts = {};
    if (tier)
        opts.tier = tier;
    else
        opts.excludeTiers = ['archive'];
    if (values.layer)
        opts.cognitiveLayer = values.layer;
    if (values.project)
        opts.domain = values.project;
    if (values.topic)
        opts.topic = values.topic;
    if (values.tag)
        opts.tag = values.tag;
    let chunks = [];
    try {
        chunks = await storage.listChunks(opts);
    }
    catch (err) {
        fail(`query failed: ${err.message}`);
    }
    const filtered = chunks
        .filter(c => c.importance >= minImportance)
        .sort((a, b) => b.importance - a.importance)
        .slice(0, limit);
    if (format === 'text') {
        const fakeResults = filtered.map(c => ({ chunk: c, score: c.importance }));
        process.stdout.write(formatRecalledMemories(fakeResults));
        return;
    }
    process.stdout.write(JSON.stringify({
        total: chunks.length,
        returned: filtered.length,
        results: filtered.map(chunkToWire),
    }, null, 2) + '\n');
}
async function main() {
    const [, , sub, ...rest] = process.argv;
    if (!sub || sub.startsWith('-')) {
        // Back-compat: bare invocation runs the MCP stdio server.
        await import('./server.js');
        return;
    }
    switch (sub) {
        case 'help':
        case '--help':
        case '-h':
            process.stdout.write(HELP);
            return;
        case 'search':
            await runSearch(rest);
            return;
        case 'query':
            await runQuery(rest);
            return;
        default:
            process.stderr.write(`engram-mcp: unknown subcommand "${sub}"\n\n${HELP}`);
            process.exit(2);
    }
}
main().catch(err => {
    process.stderr.write(`engram-mcp: ${err.stack ?? err}\n`);
    process.exit(1);
});
//# sourceMappingURL=cli.js.map