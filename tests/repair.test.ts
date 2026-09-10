/**
 * Store repairs and the instruction floor.
 *
 * Run: `npm test` or `node --import tsx --test tests/repair.test.ts`
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isCut, isCutPiece, rejoinGroups, dedupePieces, mergeContent, rejoinedSource } from '../src/repair.js';
import { stripLeakedMarkup } from '../src/wal.js';
import { trimToSentence } from '../src/episodic-consolidator.js';
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
  it('keeps a short memory whole and pieces a long one, because pieces are what retrieval finds', () => {
    const short = 'A rule with a reason attached. '.repeat(12); // about 370 characters
    assert.equal(chunkContent(short).chunks.length, 1);
    const long = 'A rule with a reason attached. '.repeat(30); // about 930 characters
    assert.ok(chunkContent(long).chunks.length > 1);
  });
});

describe('ingest sanitising', () => {
  it('drops a leaked closing tag and parameter opening before storage', () => {
    assert.equal(stripLeakedMarkup('Real memory text.</content>\n<parameter name="domain">argos'), 'Real memory text.');
    assert.equal(stripLeakedMarkup('Untouched text.'), 'Untouched text.');
  });
});

describe('merging pieces', () => {
  it('drops duplicate and contained pieces before joining', () => {
    const pieces = [
      chunk({ id: 'a', content: 'Keep required file headers (e.g.' }),
      chunk({ id: 'b', content: 'the copyright block).' }),
      chunk({ id: 'c', content: 'Keep required file headers (e.g.' }),
      chunk({ id: 'd', content: 'the copyright block).' }),
    ];
    assert.deepEqual(dedupePieces(pieces).map(p => p.id), ['a', 'b']);
    assert.equal(mergeContent(pieces), 'Keep required file headers (e.g. the copyright block).');
  });
});

describe('trimToSentence', () => {
  it('keeps whole sentences within the cap and never ends mid-word', () => {
    assert.equal(trimToSentence('First sentence here. Second one too. Third is long enough to be cut off entirely.', 40), 'First sentence here. Second one too.');
    assert.equal(trimToSentence('A single sentence that is far too long for the cap.', 10), '');
    assert.equal(trimToSentence('Careers and Oil Ch', 200), '');
  });
});

describe('isCutPiece', () => {
  it('flags only what the old splitter broke, not a heading or bullet without a period', () => {
    assert.equal(isCutPiece('Keep required file headers (e.g.'), true);
    assert.equal(isCutPiece('Never promote to stage (preview builds'), true);
    assert.equal(isCutPiece('Run it with the `! sudo pacman'), true);
    assert.equal(isCutPiece('Steps to reproduce'), false);
    assert.equal(isCutPiece('- use pkexec for root'), false);
  });
  it('a group whose pieces merely lack a trailing period is not rejoined', () => {
    const groups = rejoinGroups([
      chunk({ id: 'a', content: 'Steps to reproduce', createdAt: '2026-07-01T00:00:00.000Z' }),
      chunk({ id: 'b', content: 'Open the app and wait.', createdAt: '2026-07-01T00:00:01.000Z' }),
    ]);
    assert.equal(groups.length, 0);
  });
});

describe('rejoin judges pieces against their parent', () => {
  it('does not treat a bracket the author left open as damage', () => {
    const groups = rejoinGroups([
      chunk({ id: 'p', content: 'The value (see the coupon copy. Then the rest follows here.', createdAt: '2026-07-01T00:00:00.000Z' }),
      chunk({ id: 'c1', parentChunkId: 'p', content: 'The value (see the coupon copy.', createdAt: '2026-07-01T00:00:00.000Z' }),
      chunk({ id: 'c2', parentChunkId: 'p', content: 'Then the rest follows here.', createdAt: '2026-07-01T00:00:00.000Z' }),
    ] as never);
    assert.equal(groups.length, 0);
  });
  it('still flags a piece the splitter broke under a balanced parent', () => {
    const groups = rejoinGroups([
      chunk({ id: 'p', content: 'Keep headers (e.g. the copyright block). Then more.', createdAt: '2026-07-01T00:00:00.000Z' }),
      chunk({ id: 'c1', parentChunkId: 'p', content: 'Keep headers (e.g.', createdAt: '2026-07-01T00:00:00.000Z' }),
      chunk({ id: 'c2', parentChunkId: 'p', content: 'the copyright block). Then more.', createdAt: '2026-07-01T00:00:00.000Z' }),
    ] as never);
    assert.equal(groups.length, 1);
  });
});

describe('repair runs once per memory', () => {
  it('skips a memory it already re-ingested, whatever its pieces look like', () => {
    const groups = rejoinGroups([
      chunk({ id: 'p', source: 'wal:9:rejoined', content: 'Keep headers (e.g. the block). More.', createdAt: '2026-07-01T00:00:00.000Z' }),
      chunk({ id: 'c1', source: 'wal:9:rejoined', parentChunkId: 'p', content: 'Keep headers (e.g.', createdAt: '2026-07-01T00:00:00.000Z' }),
      chunk({ id: 'c2', source: 'wal:9:rejoined', parentChunkId: 'p', content: 'the block). More.', createdAt: '2026-07-01T00:00:00.000Z' }),
    ] as never);
    assert.equal(groups.length, 0);
  });
  it('marks a re-ingested memory once, never as a chain', () => {
    assert.equal(rejoinedSource('wal:9'), 'wal:9:rejoined');
    assert.equal(rejoinedSource('wal:9:rejoined2:rejoined'), 'wal:9:rejoined');
    assert.equal(rejoinedSource(undefined), undefined);
  });
});
