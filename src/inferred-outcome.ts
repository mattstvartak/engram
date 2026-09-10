/**
 * Inferred recall outcomes.
 *
 * The recall feedback loop (recordRecallOutcome) was only ever fed by an agent
 * calling memory-outcome by hand, and agents do not. Measured over one working
 * session: five memory-search calls, seven memory-ingest calls, zero outcomes.
 * Every promotion and decay decision downstream of that signal was starved.
 *
 * This module grades searches mechanically from the Claude Code transcript,
 * the same way the stop hook builds a checkpoint: no LLM, one pass over the
 * JSONL. For each memory-search result set it asks one question of everything
 * the assistant produced afterwards: did distinctive material from this chunk
 * show up in what the assistant said or did? A file path, an identifier, an
 * id, a number, a proper noun. Enough of that and the chunk was used; none of
 * it and the chunk was returned for nothing.
 *
 * It infers only "helpful" and "irrelevant". "corrected" means the memory was
 * wrong, which a substring heuristic cannot tell from a memory that was merely
 * unused, so that stays explicit.
 *
 * Limits, stated so nobody over-trusts it: an assistant that quotes a search
 * result back to the user without acting on it reads as helpful. The signal
 * that matters most is the negative one, because until now nothing was ever
 * marked irrelevant at all.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SmartMemoryConfig } from './types.js';
import type { Storage } from './storage.js';
import { recordRecallOutcome } from './outcome.js';

export interface RecalledChunk {
  id: string;
  content: string;
}

export interface ParsedSearch {
  toolUseId: string;
  query: string;
  /** Index of the assistant turn that issued the search. */
  turn: number;
  chunks: RecalledChunk[];
}

export interface ParsedTranscript {
  searches: ParsedSearch[];
  /** One entry per assistant turn: its text plus the inputs of the tools it called. */
  assistantTurns: string[];
}

export interface GradedSearch {
  toolUseId: string;
  query: string;
  helpful: string[];
  irrelevant: string[];
}

export interface GradeOptions {
  /** A search is graded once this many assistant turns have followed it. */
  minTurnsAfter?: number;
  /** Grade everything regardless of maturity; for session end. */
  final?: boolean;
}

export interface GradeSummary {
  graded: number;
  helpful: number;
  irrelevant: number;
  immature: number;
  alreadyGraded: number;
}

const DEFAULT_MIN_TURNS_AFTER = 3;
const HELPFUL_THRESHOLD = 3;

/** Tools whose inputs must not count as evidence of use, or the store grades its own echoes. */
function isMemoryTool(name: string): boolean {
  return /memory-|engram-/.test(name);
}

function isSearchTool(name: string): boolean {
  return /memory-search$|engram-search$/.test(name);
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((p): p is { type: string; text?: string } => !!p && typeof p === 'object')
    .filter(p => p.type === 'text' && typeof p.text === 'string')
    .map(p => p.text as string)
    .join('\n');
}

function chunksFromResult(content: unknown): RecalledChunk[] {
  const raw = textOf(content).trim();
  if (!raw.startsWith('{')) return [];
  try {
    const parsed = JSON.parse(raw) as { results?: Array<{ id?: unknown; content?: unknown }> };
    if (!Array.isArray(parsed.results)) return [];
    return parsed.results
      .filter(r => typeof r.id === 'string' && typeof r.content === 'string')
      .map(r => ({ id: r.id as string, content: r.content as string }));
  } catch {
    return [];
  }
}

export function parseTranscript(lines: string[]): ParsedTranscript {
  const pending = new Map<string, { query: string; turn: number }>();
  const searches: ParsedSearch[] = [];
  const assistantTurns: string[] = [];

  for (const line of lines) {
    let obj: { type?: string; message?: { content?: unknown } };
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const content = obj.message?.content;

    if (obj.type === 'assistant' && Array.isArray(content)) {
      const turn = assistantTurns.length;
      const parts: string[] = [];
      for (const p of content as Array<Record<string, unknown>>) {
        if (!p || typeof p !== 'object') continue;
        if (p.type === 'text' && typeof p.text === 'string') parts.push(p.text);
        if (p.type === 'tool_use') {
          const name = typeof p.name === 'string' ? p.name : '';
          const input = (p.input ?? {}) as Record<string, unknown>;
          if (isSearchTool(name) && typeof p.id === 'string') {
            pending.set(p.id, { query: typeof input.query === 'string' ? input.query : '', turn });
          }
          if (!isMemoryTool(name)) parts.push(JSON.stringify(input));
        }
      }
      assistantTurns.push(parts.join('\n'));
      continue;
    }

    if (obj.type === 'user' && Array.isArray(content)) {
      for (const p of content as Array<Record<string, unknown>>) {
        if (!p || p.type !== 'tool_result' || typeof p.tool_use_id !== 'string') continue;
        const issued = pending.get(p.tool_use_id);
        if (!issued) continue;
        pending.delete(p.tool_use_id);
        const chunks = chunksFromResult(p.content);
        if (chunks.length) searches.push({ toolUseId: p.tool_use_id, query: issued.query, turn: issued.turn, chunks });
      }
    }
  }

  return { searches, assistantTurns };
}

const STOPWORDS = new Set([
  'about', 'after', 'again', 'against', 'because', 'before', 'between', 'could', 'during', 'every',
  'first', 'other', 'should', 'since', 'still', 'their', 'there', 'these', 'those', 'through',
  'under', 'until', 'where', 'which', 'while', 'would', 'never', 'always', 'rather', 'instead',
]);

/**
 * Pull the tokens from a memory that are unlikely to appear in unrelated text, each with a
 * weight for how strong a match it is. A path or an id on its own is enough to call a chunk
 * used; a proper noun is not.
 */
export function distinctiveTokens(content: string): Map<string, number> {
  const out = new Map<string, number>();
  const add = (tok: string, w: number) => {
    const t = tok.replace(/^[`"'(\[{<]+|[`"'.,;:)\]}>!?]+$/g, '');
    if (t.length >= 4 && !STOPWORDS.has(t.toLowerCase())) out.set(t, Math.max(out.get(t) ?? 0, w));
  };

  for (const m of content.matchAll(/`([^`]{6,80})`/g)) add(m[1], 2);
  for (const m of content.matchAll(/"([^"]{8,80})"/g)) add(m[1], 2);

  const words = content.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const w = words[i].replace(/^[`"'(\[{<]+|[`"'.,;:)\]}>!?]+$/g, '');
    if (w.length < 4) continue;
    if (/^[A-Za-z0-9._~-]+\/[A-Za-z0-9._~\/-]+$/.test(w)) { add(w, 3); continue; }
    if (/^[0-9A-Za-z]{16,}$/.test(w) && /\d/.test(w) && /[A-Za-z]/.test(w)) { add(w, 3); continue; }
    if (/^[0-9a-f]{12,}$/i.test(w)) { add(w, 3); continue; }
    if (/^[A-Za-z]\w*(::|_)\w+/.test(w) || /[a-z][A-Z]/.test(w) || /^[a-z]+\.[a-z]+(\.[a-z]+)*$/.test(w)) {
      if (w.length >= 6) { add(w, 2); continue; }
    }
    if (/^\d{4,}(\.\d+)?$/.test(w)) { add(w, 1); continue; }
    const prevEndsSentence = i === 0 || /[.!?:]$/.test(words[i - 1]);
    if (/^[A-Z][a-z]{4,}$/.test(w) && !prevEndsSentence) add(w, 1);
  }
  return out;
}

export function chunkWasUsed(content: string, laterOutput: string): boolean {
  let score = 0;
  for (const [tok, w] of distinctiveTokens(content)) {
    if (laterOutput.includes(tok)) {
      score += w;
      if (score >= HELPFUL_THRESHOLD) return true;
    }
  }
  return false;
}

/**
 * Grade every mature search in a parsed transcript. Pure: no storage, no state file.
 */
export function gradeSearches(parsed: ParsedTranscript, opts: GradeOptions = {}): { graded: GradedSearch[]; immature: number } {
  const minAfter = opts.minTurnsAfter ?? DEFAULT_MIN_TURNS_AFTER;
  const lastTurn = parsed.assistantTurns.length - 1;
  const graded: GradedSearch[] = [];
  let immature = 0;

  for (const s of parsed.searches) {
    if (!opts.final && lastTurn - s.turn < minAfter) { immature++; continue; }
    const later = parsed.assistantTurns.slice(s.turn + 1).join('\n');
    const helpful: string[] = [];
    const irrelevant: string[] = [];
    for (const c of s.chunks) (chunkWasUsed(c.content, later) ? helpful : irrelevant).push(c.id);
    graded.push({ toolUseId: s.toolUseId, query: s.query, helpful, irrelevant });
  }
  return { graded, immature };
}

function stateDir(dataDir: string): string {
  return join(dataDir, 'outcomes');
}

function statePath(dataDir: string, sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
  return join(stateDir(dataDir), `graded-${safe}.json`);
}

export function readGradedState(dataDir: string, sessionId: string): Set<string> {
  const p = statePath(dataDir, sessionId);
  if (!existsSync(p)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as { toolUseIds?: unknown };
    return new Set(Array.isArray(parsed.toolUseIds) ? parsed.toolUseIds.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

export function writeGradedState(dataDir: string, sessionId: string, ids: Set<string>): void {
  const dir = stateDir(dataDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(statePath(dataDir, sessionId), JSON.stringify({ toolUseIds: [...ids] }, null, 2), 'utf8');
}

/**
 * The whole loop for one transcript. Parses first and opens storage only when there is
 * something new to record, so the per-turn hook stays cheap when nothing has matured.
 */
export async function gradeTranscript(
  config: SmartMemoryConfig,
  openStorage: () => Promise<Storage>,
  transcriptPath: string,
  sessionId: string,
  opts: GradeOptions & { dryRun?: boolean } = {}
): Promise<GradeSummary> {
  const summary: GradeSummary = { graded: 0, helpful: 0, irrelevant: 0, immature: 0, alreadyGraded: 0 };
  if (!existsSync(transcriptPath)) return summary;

  const lines = readFileSync(transcriptPath, 'utf8').split('\n');
  const parsed = parseTranscript(lines);
  const { graded, immature } = gradeSearches(parsed, opts);
  summary.immature = immature;

  const done = readGradedState(config.dataDir, sessionId);
  const fresh = graded.filter(g => !done.has(g.toolUseId));
  summary.alreadyGraded = graded.length - fresh.length;
  if (!fresh.length) return summary;

  const storage = opts.dryRun ? null : await openStorage();
  for (const g of fresh) {
    if (storage) {
      if (g.helpful.length) await recordRecallOutcome(config, storage, g.helpful, 'helpful', sessionId);
      if (g.irrelevant.length) await recordRecallOutcome(config, storage, g.irrelevant, 'irrelevant', sessionId);
    }
    summary.graded++;
    summary.helpful += g.helpful.length;
    summary.irrelevant += g.irrelevant.length;
    done.add(g.toolUseId);
  }
  if (!opts.dryRun) writeGradedState(config.dataDir, sessionId, done);
  return summary;
}
