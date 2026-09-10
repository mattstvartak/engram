/**
 * Store repairs that the measurements asked for.
 *
 * Rejoin: the chunker used to split long memories at sentence boundaries with a naive rule and
 * stored the pieces, some of them cut at "(e.g." or inside a backticked command. Measured on a
 * live store: 126 chunks cut mid-sentence, 72 of them with a same-source sibling holding the
 * rest. The pieces of one ingest share a source and were written within a few seconds of each
 * other, which is enough to find them and put the memory back together. The merged memory goes
 * through the normal ingest path so it is embedded fresh; updating content in place would leave
 * the old vector behind. The pieces are then deleted.
 *
 * Floor: corrections and preferences the user stated explicitly had decayed to the 0.15 floor,
 * 314 of them, and were losing retrieval to passing notes. The consolidator now floors them at
 * INSTRUCTION_FLOOR; this lifts the ones already below it.
 */

import type { SmartMemoryConfig } from './types.js';
import type { Storage, StoredChunk } from './storage.js';
import { ingest } from './wal.js';
import { INSTRUCTION_FLOOR, instructionFloor } from './consolidator.js';

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
  dryRun: boolean;
}

const CUT = /[^.!?)"'`]$|\((?:e\.g|i\.e)\.?$/;

export function isCut(content: string): boolean {
  const t = content.trim();
  if (!t) return false;
  const opens = (t.match(/\(/g) ?? []).length;
  const closes = (t.match(/\)/g) ?? []).length;
  return CUT.test(t) || opens > closes;
}

/**
 * Groups of pieces worth rejoining: same source, created within `windowMs` of each other, first
 * piece cut, merged length inside `maxMerged`. Pure, so it can be tested and dry-run.
 */
export function rejoinGroups(chunks: StoredChunk[], opts: { windowMs?: number; maxMerged?: number; all?: boolean } = {}): RejoinGroup[] {
  const windowMs = opts.windowMs ?? 5000;
  const maxMerged = opts.maxMerged ?? 4000;
  // With `all`, every multi-piece memory written together is rejoined, cut or not. That is the
  // experiment for whether splitting itself hurts recall; run it on a copy and measure.
  const requireCut = !opts.all;
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
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const first = new Date(list[0].createdAt).getTime();
    const last = new Date(list[list.length - 1].createdAt).getTime();
    if (last - first > windowMs) continue;
    const cut = list.slice(0, -1).some(c => isCut(c.content));
    if (requireCut && !cut) continue;
    const mergedLength = list.reduce((n, c) => n + c.content.length + 1, 0);
    if (mergedLength > maxMerged) continue;
    groups.push({ source, ids: list.map(c => c.id), mergedLength, cut });
  }
  return groups;
}

function mergeContent(pieces: StoredChunk[]): string {
  // A cut piece ends mid-sentence, so it joins its successor with a space rather than a break.
  let out = '';
  for (const p of pieces) {
    const t = p.content.trim();
    if (!out) { out = t; continue; }
    out += (isCut(out) ? ' ' : '\n\n') + t;
  }
  return out;
}

export async function repairStore(config: SmartMemoryConfig, storage: Storage, opts: { dryRun?: boolean; rejoinAll?: boolean } = {}): Promise<RepairReport> {
  const dryRun = !!opts.dryRun;
  const all = await storage.listChunks();
  const byId = new Map(all.map(c => [c.id, c]));
  const report: RepairReport = { groupsConsidered: 0, groupsRejoined: 0, piecesRemoved: 0, floored: 0, dryRun };

  for (const g of rejoinGroups(all, { all: !!opts.rejoinAll })) {
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
        source: head.source ? `${head.source}:rejoined` : undefined,
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

  for (const c of all) {
    const floor = instructionFloor(c);
    if (floor > 0 && c.importance < floor) {
      if (!dryRun) await storage.updateChunk(c.id, { importance: INSTRUCTION_FLOOR });
      report.floored++;
    }
  }
  return report;
}
