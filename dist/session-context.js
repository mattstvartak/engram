/**
 * Session-start context.
 *
 * Rules and handoffs only helped when the agent remembered to ask for them, and
 * measured over a day it did not: a rule set at importance 0.95 that morning was
 * never queried that afternoon, and the mistake it described was made again. So
 * the store now pushes instead of waiting to be pulled. A SessionStart hook runs
 * this once and prints it, and Claude Code adds the output to the session's
 * context before the first message.
 *
 * Four sections, each capped, all of it capped again as a whole so a large
 * store cannot flood the window:
 *
 *   1. The latest handoff, or the rolling crash checkpoint if that is newer.
 *   2. Procedural rules, top by confidence.
 *   3. Corrections and preferences with high importance: the things the user
 *      said after something went wrong.
 *   4. Memories whose domain matches the working directory's name.
 *
 * Nothing here needs an LLM. If the store is missing or unreadable the caller
 * prints nothing and exits clean; a memory problem must never block a session.
 */
import { basename, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { readHandoff } from './handoff.js';
const DEFAULTS = {
    maxChars: 10_000,
    maxRules: 20,
    minRuleConfidence: 0.5,
    maxCorrections: 10,
    minCorrectionImportance: 0.85,
    maxProjectMemories: 8,
};
/**
 * Some ingests arrived with the tool call's closing tag and the next parameter's opening leaked
 * into the content. Strip that when rendering, and treat a chunk that is nothing else as noise.
 */
export function stripLeakedMarkup(content) {
    return content.replace(/<\/content>[\s\S]*$/, '').replace(/<parameter name="[^"]*">[^\n]*/g, '').trim();
}
/**
 * Pieces of one ingest share a source, and the chunker splits a long ingest into several, so the
 * source is the honest key when there is one. Without it, the first sixty characters of the
 * normalised text catch the restatements and short forms the extractor tends to produce.
 */
function dedupeKey(c, content) {
    if (c.source)
        return `src:${c.source}`;
    return 'txt:' + content.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 60);
}
/** Keep the first of any near-identical entries, drop leaked markup and anything too short to mean much. */
export function dedupe(chunks) {
    const seen = new Set();
    const out = [];
    for (const c of chunks) {
        const content = stripLeakedMarkup(c.content);
        if (content.length < 12)
            continue;
        const key = dedupeKey(c, content);
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push({ ...c, content });
    }
    return out;
}
function clip(s, n) {
    const t = s.replace(/\s+/g, ' ').trim();
    return t.length <= n ? t : t.slice(0, n - 1) + '…';
}
/**
 * The stop hook overwrites one plain file, session-checkpoint.json, with no name and no stamp in
 * its filename, so neither of readHandoff's lookups can see it. Read it by path.
 */
function readCheckpoint(dataDir) {
    const p = join(dataDir, 'handoffs', 'session-checkpoint.json');
    if (!existsSync(p))
        return null;
    try {
        return JSON.parse(readFileSync(p, 'utf8'));
    }
    catch {
        return null;
    }
}
function handoffSection(dataDir) {
    let latest = null;
    try {
        latest = readHandoff(dataDir);
    }
    catch {
        latest = null;
    }
    const checkpoint = readCheckpoint(dataDir);
    if (checkpoint && (!latest || checkpoint.timestamp > latest.timestamp))
        latest = checkpoint;
    if (!latest)
        return '';
    const label = latest.reason === 'context-pressure' ? 'crash checkpoint (newer than the last handoff)' : 'handoff';
    const lines = [`## Work in flight, from the last ${label}`];
    const when = latest.timestamp ? ` (${latest.timestamp.slice(0, 16).replace('T', ' ')} UTC)` : '';
    lines.push(`${latest.name ? `**${latest.name}**` : 'Unnamed'}${when}`);
    if (latest.currentTask)
        lines.push(`Task: ${clip(latest.currentTask, 300)}`);
    const list = (title, items, cap) => {
        if (!items || !items.length)
            return;
        lines.push(`${title}:`);
        for (const it of items.slice(0, cap))
            lines.push(`- ${clip(it, 220)}`);
    };
    list('Next', latest.nextSteps, 6);
    list('Open questions', latest.openQuestions, 4);
    list('Decisions', latest.decisions, 5);
    if (latest.notes)
        lines.push(`Notes: ${clip(latest.notes, 400)}`);
    return lines.join('\n');
}
async function rulesSection(storage, o) {
    const rules = (await storage.getRules())
        .filter(r => r.confidence >= o.minRuleConfidence && r.contradictions <= r.reinforcements)
        .sort((a, b) => b.reinforcements - a.reinforcements || b.confidence - a.confidence)
        .slice(0, o.maxRules);
    if (!rules.length)
        return '';
    return ['## Standing rules', ...rules.map(r => `- ${clip(r.rule, 240)}`)].join('\n');
}
function correctionsSection(all, o) {
    const strong = dedupe(all
        .filter(c => (c.type === 'correction' || c.type === 'preference') && c.importance >= o.minCorrectionImportance)
        .sort((a, b) => b.importance - a.importance || (b.createdAt ?? '').localeCompare(a.createdAt ?? '')))
        .slice(0, o.maxCorrections);
    if (!strong.length)
        return '';
    return ['## Things the user has corrected or asked for', ...strong.map(c => `- ${clip(c.content, 320)}`)].join('\n');
}
function projectSection(all, cwd, o) {
    if (!cwd)
        return '';
    const project = basename(cwd).toLowerCase();
    if (!project || project === '/' || project === '.')
        return '';
    const mine = dedupe(all
        .filter(c => (c.domain ?? '').toLowerCase() === project)
        .sort((a, b) => b.importance - a.importance || (b.createdAt ?? '').localeCompare(a.createdAt ?? '')))
        .slice(0, o.maxProjectMemories);
    if (!mine.length)
        return '';
    return [`## About ${project}`, ...mine.map(c => `- ${clip(c.content, 280)}`)].join('\n');
}
/**
 * Build the markdown that a SessionStart hook prints. Never throws on an empty
 * store; returns '' when there is nothing worth saying.
 */
export async function buildSessionContext(storage, dataDir, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const all = await storage.listChunks();
    const sections = [
        handoffSection(dataDir),
        await rulesSection(storage, o),
        correctionsSection(all, o),
        projectSection(all, opts.cwd, o),
    ].filter(Boolean);
    if (!sections.length)
        return '';
    const header = '# From przm-memory\n\nLoaded automatically at session start. Search the store for anything deeper; write a handoff at commits and before long background work.';
    let out = [header, ...sections].join('\n\n');
    if (out.length > o.maxChars) {
        out = out.slice(0, o.maxChars - 60).replace(/\n[^\n]*$/, '') + '\n\n(cut at the size cap; search the store for more)';
    }
    return out;
}
//# sourceMappingURL=session-context.js.map