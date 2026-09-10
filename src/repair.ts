/**
 * Store repairs that the measurements asked for.
 *
 * Re-ingest: a long memory is stored as a whole parent plus child pieces, and the chunker used
 * to cut those pieces at "(e.g." or inside a backticked command. The parent always held the
 * whole text, so nothing was lost, but the cut children were noise. A memory whose pieces are
 * cut is re-ingested from its whole text through the normal path, which embeds it fresh and
 * derives the pieces again with the fixed splitter; the old parent and pieces are deleted.
 * Pieces are deduplicated first because a parent contains its own children.
 *
 * Floor: corrections and preferences the user stated explicitly had decayed to the 0.15 floor,
 * 314 of them, and were losing retrieval to passing notes. The consolidator now floors them at
 * INSTRUCTION_FLOOR; this lifts the ones already below it.
 */

import type { SmartMemoryConfig } from './types.js';
import type { Storage, StoredChunk } from './storage.js';
import { ingest } from './wal.js';
import { INSTRUCTION_FLOOR, instructionFloor } from './consolidator.js';
import { trimToSentence } from './episodic-consolidator.js';

export interface RejoinGroup {
  source: string;
  ids: string[];
  mergedLength: number;
  /** True when the first piece is cut mid-sentence, which is what makes the group worth rejoining. */
  cut: boolean;
}

export interface RepairReport {
  groupsConsidered: number;
  groupsRejoined: number;
  piecesRemoved: number;
  floored: number;
  /** Derived consolidation summaries that ended mid-word and were trimmed to their last whole sentence, or deleted when none remained. */
  summariesTrimmed: number;
  summariesDeleted: number;
  dryRun: boolean;
}

const CUT = /[^.!?)"'`]$|\((?:e\.g|i\.e)\.?$/;
const REJOINED = /:rejoined\d*(?::rejoined\d*)*$/;

/** The source a re-ingested memory carries: the original with one marker, never a chain of them. */
export function rejoinedSource(source: string | undefined): string | undefined {
  return source ? `${source.replace(REJOINED, '')}:rejoined` : undefined;
}

/** Prose that stops before its sentence ends. Right for summaries, too broad for pieces. */
export function isCut(content: string): boolean {
  const t = content.trim();
  if (!t) return false;
  const opens = (t.match(/\(/g) ?? []).length;
  const closes = (t.match(/\)/g) ?? []).length;
  return CUT.test(t) || opens > closes;
}

/**
 * A piece the old splitter damaged: cut at an abbreviation, inside a bracket, or inside a
 * backticked span. A piece that merely ends on a heading or a bullet without a period is not
 * damaged, and treating it as such made the repair re-ingest the same memories on every run.
 */
export function isCutPiece(content: string): boolean {
  const t = content.trim();
  if (!t) return false;
  const opens = (t.match(/\(/g) ?? []).length;
  const closes = (t.match(/\)/g) ?? []).length;
  const backticks = (t.match(/`/g) ?? []).length;
  return /\((?:e\.g|i\.e)\.?$/i.test(t) || opens > closes || backticks % 2 === 1;
}

/**
 * Groups of pieces worth rejoining: same source, created within `windowMs` of each other, first
 * piece cut, merged length inside `maxMerged`. Pure, so it can be tested and dry-run.
 */
export function rejoinGroups(chunks: StoredChunk[], opts: { windowMs?: number; maxMerged?: number } = {}): RejoinGroup[] {
  const windowMs = opts.windowMs ?? 5000;
  const maxMerged = opts.maxMerged ?? 4000;
  const bySource = new Map<string, StoredChunk[]>();
  for (const c of chunks) {
    if (!c.source) continue;
    const list = bySource.get(c.source) ?? [];
    list.push(c);
    bySource.set(c.source, list);
  }
  const groups: RejoinGroup[] = [];
  for (const [source, list] of bySource) {
    if (list.length < 2) continue;
    // One pass per memory. A memory already re-ingested by this repair went through the fixed
    // splitter; if a piece still ends inside a bracket, the author wrote a parenthetical that
    // spans a paragraph break, and re-ingesting again cannot change that.
    if (REJOINED.test(source)) continue;
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const first = new Date(list[0].createdAt).getTime();
    const last = new Date(list[list.length - 1].createdAt).getTime();
    if (last - first > windowMs) continue;
    // Damage is a piece the splitter broke, judged against its parent: a parent whose author
    // left a bracket open hands that imbalance to its pieces, and there is nothing to fix.
    const pieces = list.filter(c => c.parentChunkId);
    // Only a group that has children has a parent; a group of standalone pieces has none to judge by.
    const parent = pieces.length ? list.find(c => !c.parentChunkId) : undefined;
    const parentBroken = parent ? isCutPiece(parent.content) : false;
    const cut = !parentBroken && (pieces.length ? pieces : list.slice(0, -1)).some(c => isCutPiece(c.content));
    if (!cut) continue;
    const mergedLength = list.reduce((n, c) => n + c.content.length + 1, 0);
    if (mergedLength > maxMerged) continue;
    groups.push({ source, ids: list.map(c => c.id), mergedLength, cut });
  }
  return groups;
}

function normalised(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * A source id groups everything written in one flush, and some flushes stored the same memory
 * more than once. Measured after a first repair: the largest rejoined memory held the same
 * passages three times. Drop a piece that equals, contains, or is contained in one already kept.
 */
export function dedupePieces(pieces: StoredChunk[]): StoredChunk[] {
  const kept: StoredChunk[] = [];
  const seen: string[] = [];
  for (const p of pieces) {
    const n = normalised(p.content);
    if (!n) continue;
    if (seen.some(x => x === n || x.includes(n) || n.includes(x))) continue;
    seen.push(n);
    kept.push(p);
  }
  return kept;
}

export function mergeContent(pieces: StoredChunk[]): string {
  // A cut piece ends mid-sentence, so it joins its successor with a space rather than a break.
  let out = '';
  for (const p of dedupePieces(pieces)) {
    const t = p.content.trim();
    if (!out) { out = t; continue; }
    out += (isCut(out) ? ' ' : '\n\n') + t;
  }
  return out;
}

export async function repairStore(config: SmartMemoryConfig, storage: Storage, opts: { dryRun?: boolean } = {}): Promise<RepairReport> {
  const dryRun = !!opts.dryRun;
  const all = await storage.listChunks();
  const byId = new Map(all.map(c => [c.id, c]));
  const report: RepairReport = { groupsConsidered: 0, groupsRejoined: 0, piecesRemoved: 0, floored: 0, summariesTrimmed: 0, summariesDeleted: 0, dryRun };

  for (const g of rejoinGroups(all)) {
    report.groupsConsidered++;
    const pieces = g.ids.map(id => byId.get(id)).filter((c): c is StoredChunk => !!c);
    if (pieces.length !== g.ids.length) continue;
    const head = pieces[0];
    if (!dryRun) {
      // Ingest embeds the merged memory; keep everything else the pieces agreed on, and the
      // original date so the contextual prefix does not claim it is new.
      const merged = await ingest(config, storage, [{
        content: mergeContent(pieces),
        type: head.type,
        layer: head.cognitiveLayer,
        importance: Math.max(...pieces.map(p => p.importance)),
        tags: head.tags,
        source: rejoinedSource(head.source),
        domain: head.domain,
        topic: head.topic,
        origin: head.origin,
        tier: head.tier === 'archive' ? undefined : head.tier,
        createdAt: head.createdAt,
      }]);
      if (!merged.length) continue;
      for (const p of pieces) await storage.deleteChunk(p.id);
    }
    report.groupsRejoined++;
    report.piecesRemoved += pieces.length;
  }

  // Consolidation summaries written by the old heuristic end mid-word. Keep the whole sentences.
  for (const c of all) {
    if (!c.source?.startsWith('consolidation:') || (c.origin ?? 'user') !== 'derived') continue;
    if (!isCut(c.content)) continue;
    const trimmed = trimToSentence(c.content, c.content.length);
    if (trimmed.length >= 40) {
      if (!dryRun) await storage.updateChunk(c.id, { content: trimmed });
      report.summariesTrimmed++;
    } else {
      if (!dryRun) await storage.deleteChunk(c.id);
      report.summariesDeleted++;
    }
  }

  for (const c of all) {
    const floor = instructionFloor(c);
    if (floor > 0 && c.importance < floor) {
      if (!dryRun) await storage.updateChunk(c.id, { importance: INSTRUCTION_FLOOR });
      report.floored++;
    }
  }
  return report;
}
