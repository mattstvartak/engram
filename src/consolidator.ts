import type { StoredChunk } from './storage.js';
import { Storage } from './storage.js';
import { cosineSimilarity, getEdgeTargetIds, addEdge } from './utils.js';

export interface ConsolidationStats {
  linked: number;
  decayed: number;
  promoted: number;
  demoted: number;
  reactivated: number;
  dailyMoved: number;
  merged: number;
}

/**
 * Background consolidation pass: links, decays, promotes, demotes, and merges memories.
 * Run this periodically (e.g., daily or at session start).
 */
export async function consolidate(storage: Storage): Promise<ConsolidationStats> {
  const stats: ConsolidationStats = {
    linked: 0, decayed: 0, promoted: 0, demoted: 0,
    reactivated: 0, dailyMoved: 0, merged: 0,
  };

  const chunks = await storage.listChunks();

  stats.dailyMoved = await processDailyTier(storage, chunks);
  stats.promoted = await promoteChunks(storage, chunks);
  stats.demoted = await demoteToArchive(storage, chunks);
  stats.reactivated = await reactivateArchived(storage, chunks);
  stats.linked = await linkRelated(storage, chunks);
  stats.decayed = await decayImportance(storage, chunks) + await decayIrrelevant(storage, chunks);
  stats.merged = await mergeNearDuplicates(storage, chunks);

  return stats;
}

// ── Daily → Short-term ───────────────────────────────────────────────

async function processDailyTier(storage: Storage, chunks: StoredChunk[]): Promise<number> {
  let moved = 0;
  const now = Date.now();
  const retentionMs = 2 * 86_400_000;

  for (const chunk of chunks) {
    if (chunk.tier !== 'daily') continue;
    if (now - new Date(chunk.createdAt).getTime() >= retentionMs) {
      if (chunk.importance >= 0.3 || chunk.recallCount > 0) {
        await storage.updateChunk(chunk.id, { tier: 'short-term' });
        moved++;
      }
    }
  }
  return moved;
}

// ── Short-term → Long-term ───────────────────────────────────────────

async function promoteChunks(storage: Storage, chunks: StoredChunk[]): Promise<number> {
  let promoted = 0;

  for (const chunk of chunks) {
    if (chunk.tier !== 'short-term') continue;

    const ageDays = daysSince(chunk.createdAt);
    const lastRecalledDays = chunk.lastRecalledAt ? daysSince(chunk.lastRecalledAt) : Infinity;
    const helpfulCount = chunk.recallOutcomes.filter(o => o.outcome === 'helpful').length;

    const shouldPromote =
      chunk.importance >= 0.8 ||
      (chunk.recallCount >= 3 && ageDays >= 7) ||
      (helpfulCount >= 2 && lastRecalledDays < 7) ||
      (chunk.cognitiveLayer === 'procedural' && chunk.importance >= 0.5) ||
      (chunk.recallCount >= 1 && ageDays >= 30 && lastRecalledDays < 7);

    if (shouldPromote) {
      await storage.updateChunk(chunk.id, { tier: 'long-term' });
      promoted++;
    }
  }
  return promoted;
}

// ── Long-term → Archive ──────────────────────────────────────────────

async function demoteToArchive(storage: Storage, chunks: StoredChunk[]): Promise<number> {
  let demoted = 0;
  const now = Date.now();

  for (const chunk of chunks) {
    if (chunk.tier !== 'long-term') continue;

    const ageMs = now - new Date(chunk.createdAt).getTime();
    const lastRecallMs = chunk.lastRecalledAt
      ? now - new Date(chunk.lastRecalledAt).getTime()
      : Infinity;

    const tooOld = ageMs >= 90 * 86_400_000;
    const inactive = lastRecallMs >= 30 * 86_400_000;

    if (tooOld || (inactive && chunk.importance < 0.3)) {
      await storage.updateChunk(chunk.id, { tier: 'archive' });
      demoted++;
    }
  }
  return demoted;
}

// ── Archive → Long-term (reactivation) ───────────────────────────────

async function reactivateArchived(storage: Storage, chunks: StoredChunk[]): Promise<number> {
  let reactivated = 0;
  const now = Date.now();

  for (const chunk of chunks) {
    if (chunk.tier !== 'archive' || !chunk.lastRecalledAt) continue;
    if (now - new Date(chunk.lastRecalledAt).getTime() < 7 * 86_400_000) {
      await storage.updateChunk(chunk.id, { tier: 'long-term' });
      reactivated++;
    }
  }
  return reactivated;
}

// ── Tag-based Linking ────────────────────────────────────────────────

async function linkRelated(storage: Storage, chunks: StoredChunk[]): Promise<number> {
  let linked = 0;

  const tagIndex = new Map<string, string[]>();
  const chunkMap = new Map<string, StoredChunk>();
  for (const chunk of chunks) {
    if (chunk.tier === 'archive') continue;
    chunkMap.set(chunk.id, chunk);
    for (const tag of chunk.tags) {
      const ids = tagIndex.get(tag) ?? [];
      ids.push(chunk.id);
      tagIndex.set(tag, ids);
    }
  }

  const seen = new Set<string>();
  for (const [, ids] of tagIndex) {
    if (ids.length < 2 || ids.length > 50) continue;

    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = chunkMap.get(ids[i])!;
        const b = chunkMap.get(ids[j])!;
        const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
        if (seen.has(key)) continue;
        seen.add(key);

        if (getEdgeTargetIds(a.relatedMemories).includes(b.id)) continue;

        const overlap = a.tags.filter(t => b.tags.includes(t));
        if (overlap.length >= 2 || (overlap.length >= 1 && a.cognitiveLayer === b.cognitiveLayer)) {
          const rel = a.source === b.source ? 'temporal' as const : 'semantic' as const;
          const weight = Math.min(1.0, 0.3 + overlap.length * 0.15);

          const aEdges = addEdge(a.relatedMemories, b.id, rel, weight);
          const bEdges = addEdge(b.relatedMemories, a.id, rel, weight);

          await storage.updateChunk(a.id, { relatedMemories: aEdges });
          await storage.updateChunk(b.id, { relatedMemories: bEdges });
          a.relatedMemories = aEdges;
          b.relatedMemories = bEdges;
          linked++;
        }
      }
    }
  }
  return linked;
}

// ── Importance Decay ─────────────────────────────────────────────────

async function decayImportance(storage: Storage, chunks: StoredChunk[]): Promise<number> {
  let decayed = 0;
  const now = Date.now();

  const rates: Record<string, number> = { procedural: 0.98, semantic: 0.97, episodic: 0.95 };
  const floors: Record<string, number> = { procedural: 0.15, semantic: 0.10, episodic: 0.05 };

  for (const chunk of chunks) {
    if (chunk.tier === 'archive') continue;
    const lastTouch = chunk.lastRecalledAt
      ? new Date(chunk.lastRecalledAt).getTime()
      : new Date(chunk.createdAt).getTime();

    const daysSinceTouch = (now - lastTouch) / 86_400_000;
    if (daysSinceTouch < 7) continue;

    const rate = rates[chunk.cognitiveLayer] ?? 0.97;
    const floor = floors[chunk.cognitiveLayer] ?? 0.10;
    const weeks = daysSinceTouch / 7;
    const newImportance = Math.max(floor, chunk.importance * Math.pow(rate, weeks));

    if (Math.abs(newImportance - chunk.importance) > 0.01) {
      await storage.updateChunk(chunk.id, { importance: newImportance });
      decayed++;
    }
  }
  return decayed;
}

// ── Decay Irrelevant ─────────────────────────────────────────────────

async function decayIrrelevant(storage: Storage, chunks: StoredChunk[]): Promise<number> {
  let decayed = 0;

  for (const chunk of chunks) {
    const outcomes = chunk.recallOutcomes;
    if (outcomes.length < 3) continue;

    const recent = outcomes.slice(-5);
    const irrelevant = recent.filter(o => o.outcome === 'irrelevant').length;

    if (irrelevant >= 3) {
      const newImportance = Math.max(0.05, chunk.importance - 0.2);
      await storage.updateChunk(chunk.id, { importance: newImportance });
      if (newImportance <= 0.1) {
        await storage.updateChunk(chunk.id, { tier: 'archive' });
      }
      decayed++;
    }
  }
  return decayed;
}

// ── Near-duplicate Merging ───────────────────────────────────────────

async function mergeNearDuplicates(storage: Storage, chunks: StoredChunk[]): Promise<number> {
  let merged = 0;
  const consumed = new Set<string>();

  const candidates = chunks
    .filter(c => c.cognitiveLayer === 'semantic' && c.embedding && c.embedding.length > 0)
    .sort((a, b) =>
      new Date(b.lastRecalledAt ?? b.createdAt).getTime() -
      new Date(a.lastRecalledAt ?? a.createdAt).getTime()
    )
    .slice(0, 200);

  for (const chunk of candidates) {
    if (consumed.has(chunk.id)) continue;

    for (const other of candidates) {
      if (other.id === chunk.id || consumed.has(other.id)) continue;
      if (!other.embedding || !chunk.embedding) continue;

      if (cosineSimilarity(chunk.embedding, other.embedding) > 0.9) {
        const keeper = chunk.importance >= other.importance ? chunk : other;
        const loser = keeper === chunk ? other : chunk;

        await storage.updateChunk(keeper.id, {
          recallCount: keeper.recallCount + loser.recallCount,
          importance: Math.min(1.0, keeper.importance + 0.03),
        });
        await storage.deleteChunk(loser.id);
        consumed.add(loser.id);
        merged++;
      }
    }
  }
  return merged;
}

// ── Helpers ──────────────────────────────────────────────────────────

function daysSince(dateStr: string): number {
  return (Date.now() - new Date(dateStr).getTime()) / 86_400_000;
}
