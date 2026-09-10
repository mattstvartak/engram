/**
 * Store repairs and the instruction floor.
 *
 * Run: `npm test` or `node --import tsx --test tests/repair.test.ts`
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isCut, rejoinGroups } from '../src/repair.js';
import { stripLeakedMarkup } from '../src/wal.js';
import { instructionFloor, INSTRUCTION_FLOOR } from '../src/consolidator.js';
import { chunkContent } from '../src/chunker.js';
import type { StoredChunk } from '../src/storage.js';

function chunk(over: Partial<StoredChunk>): StoredChunk {
  return {
    id: over.id ?? 'x', tier: 'long-term', content: '', type: 'fact', cognitiveLayer: 'semantic', tags: [], domain: '', topic: '',
    source: 'wal:1', importance: 0.5, sentiment: 'neutral', createdAt: '2026-07-01T00:00:00.000Z', lastRecalledAt: null, recallCount: 0,
    relatedMemories: [], recallOutcomes: [], origin: 'user', ...over,
  } as StoredChunk;
}

describe('isCut', () => {
  it('flags text ending mid-sentence, at an abbreviation, or inside a bracket', () => {
    assert.equal(isCut('Keep required file headers (e.g.'), true);
    assert.equal(isCut('Never promote to stage (preview builds'), true);
    assert.equal(isCut('Run it with the `! sudo pacman -S'), true);
    assert.equal(isCut('A whole sentence.'), false);
    assert.equal(isCut('Ends in a quote."'), false);
  });
});

describe('rejoinGroups', () => {
  it('groups same-source pieces written together when the first is cut', () => {
    const groups = rejoinGroups([
      chunk({ id: 'a', content: 'Keep required file headers (e.g.', createdAt: '2026-07-01T00:00:00.000Z' }),
      chunk({ id: 'b', content: 'the copyright block some repos lint for).', createdAt: '2026-07-01T00:00:01.000Z' }),
      chunk({ id: 'c', source: 'wal:2', content: 'A whole memory on its own.', createdAt: '2026-07-01T00:00:00.000Z' }),
      chunk({ id: 'd', source: 'wal:2', content: 'Another whole one.', createdAt: '2026-07-01T00:00:01.000Z' }),
    ]);
    assert.deepEqual(groups.map(g => g.ids), [['a', 'b']]);
  });
  it('leaves pieces alone when they were not written together', () => {
    const groups = rejoinGroups([
      chunk({ id: 'a', content: 'Cut here (e.g.', createdAt: '2026-07-01T00:00:00.000Z' }),
      chunk({ id: 'b', content: 'much later).', createdAt: '2026-07-02T00:00:00.000Z' }),
    ]);
    assert.equal(groups.length, 0);
  });
});

describe('instruction floor', () => {
  it('applies to user-stated corrections and preferences only', () => {
    assert.equal(instructionFloor(chunk({ type: 'correction' })), INSTRUCTION_FLOOR);
    assert.equal(instructionFloor(chunk({ type: 'preference' })), INSTRUCTION_FLOOR);
    assert.equal(instructionFloor(chunk({ type: 'fact' })), 0);
    assert.equal(instructionFloor(chunk({ type: 'correction', origin: 'derived' })), 0);
  });
});

describe('chunker threshold', () => {
  it('keeps a memory of ordinary length whole', () => {
    const memory = 'A rule with a reason attached. '.repeat(30); // about 930 characters
    const result = chunkContent(memory);
    const chunks = (result as { chunks?: unknown[] }).chunks ?? (result as unknown[]);
    assert.equal(chunks.length, 1);
  });
});

describe('ingest sanitising', () => {
  it('drops a leaked closing tag and parameter opening before storage', () => {
    assert.equal(stripLeakedMarkup('Real memory text.</content>\n<parameter name="domain">argos'), 'Real memory text.');
    assert.equal(stripLeakedMarkup('Untouched text.'), 'Untouched text.');
  });
});
