/**
 * Chunker sentence boundaries.
 *
 * The chunker split at every `[.!?]` followed by whitespace, so a long memory was stored cut at
 * "(e.g." or inside a backticked command. It now shares the masking splitter with the extractor.
 *
 * Run: `npm test` or `node --import tsx --test tests/chunker.test.ts`
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chunkContent } from '../src/chunker.js';
import { splitSentences } from '../src/sentences.js';

describe('splitSentences', () => {
  it('does not break after e.g. or inside backticks', () => {
    assert.deepEqual(
      splitSentences('Keep required file headers (e.g. the copyright block). Run it with the `! sudo pacman -S pkg` prefix. Done.'),
      ['Keep required file headers (e.g. the copyright block).', 'Run it with the `! sudo pacman -S pkg` prefix.', 'Done.'],
    );
  });
  it('does not break inside a bracket that spans a sentence end', () => {
    assert.deepEqual(
      splitSentences('Use the own dot (see Kit.make_dot(). It is separate from fx.dot). Then continue.'),
      ['Use the own dot (see Kit.make_dot(). It is separate from fx.dot).', 'Then continue.'],
    );
  });
  it('treats semicolons as boundaries only when asked', () => {
    const text = 'Do not leave agents idle; stop them when done.';
    assert.equal(splitSentences(text).length, 1);
    assert.equal(splitSentences(text, { semicolons: true }).length, 2);
  });
});

describe('chunkContent', () => {
  const filler = 'This sentence exists to push the memory past the split threshold. ';
  it('never stores a chunk cut at an abbreviation or inside backticks', () => {
    const content = filler.repeat(6) + 'Keep required file headers (e.g. the copyright block some repos lint for). ' + filler.repeat(6) + 'Run it with the `! sudo pacman -S pkg` prefix so the output lands in the conversation. ' + filler.repeat(6);
    const result = chunkContent(content, { maxChunkLength: 300 });
    const chunks = result.chunks ?? result;
    assert.ok(chunks.length > 1, 'should split');
    for (const c of chunks) {
      const text = typeof c === 'string' ? c : c.content;
      assert.doesNotMatch(text, /\(e\.g\.$/, `cut at e.g.: ${text.slice(-40)}`);
      assert.equal((text.match(/`/g) ?? []).length % 2, 0, `odd backticks: ${text.slice(-60)}`);
    }
  });
  it('still splits ordinary prose at sentence ends', () => {
    const result = chunkContent(filler.repeat(20), { maxChunkLength: 300 });
    const chunks = result.chunks ?? result;
    assert.ok(chunks.length >= 3);
    for (const c of chunks) {
      const text = typeof c === 'string' ? c : c.content;
      assert.match(text, /\.$/);
    }
  });
});
