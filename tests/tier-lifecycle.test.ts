/**
 * Tier lifecycle (consolidator.ts).
 *
 * Short-term used to be a terminal tier: promotion required importance or
 * recall criteria most chunks never met, and demotion only ran on
 * long-term, so a default-importance never-recalled chunk sat in
 * short-term forever. These tests pin the full lifecycle: daily moves up,
 * short-term promotes when it qualifies, stale short-term archives, and
 * user-origin chunks are never auto-archived. Retention windows come from
 * config, not hardcoded constants.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ENGRAM_NO_AUTO_CLOUD = '1';
process.env.ENGRAM_SKIP_EMBED = '1';

import { Storage, type StoredChunk } from '../src/storage.js';
import { consolidate } from '../src/consolidator.js';
import { DEFAULT_CONFIG, type SmartMemoryConfig } from '../src/types.js';

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'engram-tier-lifecycle-'));
  return { dir, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* nothing */ } } };
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

function chunk(id: string, overrides: Partial<StoredChunk> = {}): StoredChunk {
  return {
    id, tier: 'short-term', content: `lifecycle test content for ${id}`, type: 'context',
    cognitiveLayer: 'episodic', tags: [], domain: '', topic: '', source: 'tier-lifecycle-test',
    importance: 0.5, sentiment: 'neutral', createdAt: daysAgo(0), lastRecalledAt: null,
    recallCount: 0, embedding: [], relatedMemories: [], recallOutcomes: [],
    stability: 1.0, difficulty: 0.3, temporalAnchor: 0, consolidationLevel: 0,
    sourceChunkIds: [], embeddingVersion: 3, parentChunkId: '', origin: 'derived',
    ...overrides,
  };
}

const config: SmartMemoryConfig = {
  ...DEFAULT_CONFIG,
  // Keep the FSRS/episodic machinery out of the way; these tests pin
  // tier transitions only.
  enableEpisodicConsolidation: false,
};

async function tierOf(storage: Storage, id: string): Promise<string> {
  const c = await storage.getChunk(id);
  assert.ok(c, `chunk ${id} should still exist`);
  return c.tier;
}

describe('tier lifecycle', () => {
  it('moves daily chunks to short-term after the configured retention', async () => {
    const { dir, cleanup } = tmp();
    try {
      const storage = new Storage(dir);
      await storage.ensureReady();
      await storage.saveChunks([
        chunk('daily-old', { tier: 'daily', createdAt: daysAgo(config.dailyRetentionDays + 1) }),
        chunk('daily-fresh', { tier: 'daily', createdAt: daysAgo(0) }),
      ]);

      await consolidate(storage, config);

      assert.equal(await tierOf(storage, 'daily-old'), 'short-term');
      assert.equal(await tierOf(storage, 'daily-fresh'), 'daily');
    } finally {
      cleanup();
    }
  });

  it('promotes qualifying short-term chunks to long-term', async () => {
    const { dir, cleanup } = tmp();
    try {
      const storage = new Storage(dir);
      await storage.ensureReady();
      await storage.saveChunks([
        chunk('important', { importance: 0.85 }),
        chunk('recalled', { createdAt: daysAgo(8), recallCount: 3 }),
        chunk('plain', { importance: 0.5 }),
      ]);

      await consolidate(storage, config);

      assert.equal(await tierOf(storage, 'important'), 'long-term');
      assert.equal(await tierOf(storage, 'recalled'), 'long-term');
      assert.equal(await tierOf(storage, 'plain'), 'short-term');
    } finally {
      cleanup();
    }
  });

  it('archives stale never-recalled short-term chunks, sparing user-origin ones', async () => {
    const { dir, cleanup } = tmp();
    try {
      const storage = new Storage(dir);
      await storage.ensureReady();
      const staleDays = config.shortTermRetentionDays + 1;
      await storage.saveChunks([
        chunk('stale-derived', { createdAt: daysAgo(staleDays), importance: 0.3 }),
        chunk('stale-user', { createdAt: daysAgo(staleDays), importance: 0.3, origin: 'user' }),
        chunk('stale-recalled', { createdAt: daysAgo(staleDays), importance: 0.3, recallCount: 2, lastRecalledAt: daysAgo(1) }),
        chunk('fresh-derived', { createdAt: daysAgo(1), importance: 0.3 }),
      ]);

      const stats = await consolidate(storage, config);

      assert.equal(await tierOf(storage, 'stale-derived'), 'archive');
      assert.equal(await tierOf(storage, 'stale-user'), 'short-term');
      assert.notEqual(await tierOf(storage, 'stale-recalled'), 'archive');
      assert.equal(await tierOf(storage, 'fresh-derived'), 'short-term');
      assert.ok(stats.shortTermArchived >= 1, 'stats should count the archived chunk');
    } finally {
      cleanup();
    }
  });

  it('demotes old inactive long-term chunks using the configured retention', async () => {
    const { dir, cleanup } = tmp();
    try {
      const storage = new Storage(dir);
      await storage.ensureReady();
      await storage.saveChunks([
        chunk('lt-ancient', { tier: 'long-term', createdAt: daysAgo(config.longTermRetentionDays + 1) }),
        chunk('lt-ancient-user', { tier: 'long-term', createdAt: daysAgo(config.longTermRetentionDays + 1), origin: 'user' }),
        chunk('lt-recent', { tier: 'long-term', createdAt: daysAgo(5) }),
      ]);

      await consolidate(storage, config);

      assert.equal(await tierOf(storage, 'lt-ancient'), 'archive');
      assert.equal(await tierOf(storage, 'lt-ancient-user'), 'long-term');
      assert.equal(await tierOf(storage, 'lt-recent'), 'long-term');
    } finally {
      cleanup();
    }
  });
});
