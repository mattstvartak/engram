/**
 * Inferred recall outcomes.
 *
 * The feedback loop behind promotion and decay was fed only by an agent calling
 * memory-outcome, and agents do not call it. These tests pin the mechanical
 * grader that replaces that dependency: a memory-search result whose distinctive
 * material shows up in what the assistant later says or does is helpful; one
 * that never does is irrelevant; "corrected" is never inferred.
 *
 * Run: `npm test` or `node --import tsx --test tests/inferred-outcome.test.ts`
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseTranscript,
  distinctiveTokens,
  chunkWasUsed,
  gradeSearches,
  gradeTranscript,
  readGradedState,
} from '../src/inferred-outcome.js';
import { loadConfig } from '../src/config.js';
import type { Storage } from '../src/storage.js';

function tmpDir() {
  const dir = mkdtempSync(join(tmpdir(), 'engram-outcome-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function assistant(parts: Array<Record<string, unknown>>): string {
  return JSON.stringify({ type: 'assistant', message: { content: parts } });
}
function toolResult(toolUseId: string, payload: unknown): string {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text }] }] } });
}
function searchCall(id: string, query: string) {
  return { type: 'tool_use', id, name: 'mcp__przm-memory__memory-search', input: { query } };
}
function results(chunks: Array<{ id: string; content: string }>) {
  return { total: chunks.length, selected: chunks.length, results: chunks.map(c => ({ ...c, type: 'fact' })) };
}

const PATH_CHUNK = { id: 'c-path', content: 'The nested session script lives at scripts/nested-session.sh and must run dbus-update-activation-environment first.' };
const IDENT_CHUNK = { id: 'c-ident', content: 'Use SocketName::path_in and UnixEndpoint::with_mode for the production socket directory.' };
const PROSE_CHUNK = { id: 'c-prose', content: 'Matt prefers small teams so that one agent is never working for too long.' };

describe('distinctiveTokens', () => {
  it('weights paths and identifiers above proper nouns', () => {
    const t = distinctiveTokens(PATH_CHUNK.content);
    assert.equal(t.get('scripts/nested-session.sh'), 3);
    assert.equal(t.get('dbus-update-activation-environment'), undefined, 'a hyphenated plain word is not an identifier');
    const i = distinctiveTokens(IDENT_CHUNK.content);
    assert.equal(i.get('SocketName::path_in'), 2);
    assert.equal(i.get('UnixEndpoint::with_mode'), 2);
  });

  it('ignores short words and stopwords', () => {
    const t = distinctiveTokens('never always the and of rather instead');
    assert.equal(t.size, 0);
  });
});

describe('chunkWasUsed', () => {
  it('one path is enough', () => {
    assert.equal(chunkWasUsed(PATH_CHUNK.content, 'ran scripts/nested-session.sh -- dolphin'), true);
  });
  it('two identifiers are enough, one is not', () => {
    assert.equal(chunkWasUsed(IDENT_CHUNK.content, 'call SocketName::path_in(dir)'), false);
    assert.equal(chunkWasUsed(IDENT_CHUNK.content, 'call SocketName::path_in(dir) then UnixEndpoint::with_mode(0o660)'), true);
  });
  it('prose with no distinctive material never matches', () => {
    assert.equal(chunkWasUsed(PROSE_CHUNK.content, 'Matt prefers small teams so that one agent is never working for too long.'), false);
  });
});

describe('parseTranscript', () => {
  it('pairs a search with its result and indexes the assistant turn', () => {
    const lines = [
      assistant([{ type: 'text', text: 'hello' }]),
      assistant([searchCall('tu-1', 'nested session')]),
      toolResult('tu-1', results([PATH_CHUNK])),
      assistant([{ type: 'text', text: 'done' }]),
    ];
    const parsed = parseTranscript(lines);
    assert.equal(parsed.searches.length, 1);
    assert.equal(parsed.searches[0].turn, 1);
    assert.equal(parsed.searches[0].query, 'nested session');
    assert.deepEqual(parsed.searches[0].chunks.map(c => c.id), ['c-path']);
    assert.equal(parsed.assistantTurns.length, 3);
  });

  it('skips formatted text results it cannot attribute to chunk ids', () => {
    const lines = [assistant([searchCall('tu-2', 'x')]), toolResult('tu-2', '## Recalled memories\n- something')];
    assert.equal(parseTranscript(lines).searches.length, 0);
  });

  it('does not count memory tool inputs as evidence of use', () => {
    const lines = [
      assistant([searchCall('tu-3', 'x')]),
      toolResult('tu-3', results([PATH_CHUNK])),
      assistant([{ type: 'tool_use', id: 'i1', name: 'mcp__przm-memory__memory-ingest', input: { content: PATH_CHUNK.content } }]),
      assistant([{ type: 'text', text: 'ok' }]),
      assistant([{ type: 'text', text: 'ok' }]),
      assistant([{ type: 'text', text: 'ok' }]),
    ];
    const parsed = parseTranscript(lines);
    const { graded } = gradeSearches(parsed);
    assert.deepEqual(graded[0].irrelevant, ['c-path'], 're-ingesting a recalled memory is not using it');
  });
});

describe('gradeSearches', () => {
  const lines = [
    assistant([searchCall('tu-a', 'sockets')]),
    toolResult('tu-a', results([PATH_CHUNK, IDENT_CHUNK, PROSE_CHUNK])),
    assistant([{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'timeout 240 scripts/nested-session.sh -- ./router-showcase' } }]),
    assistant([{ type: 'text', text: 'The socket lives wherever SocketName::path_in says, and bind uses UnixEndpoint::with_mode.' }]),
    assistant([{ type: 'text', text: 'Finished.' }]),
    assistant([searchCall('tu-b', 'late')]),
    toolResult('tu-b', results([PROSE_CHUNK])),
  ];
  const parsed = parseTranscript(lines);

  it('grades mature searches and holds immature ones back', () => {
    const { graded, immature } = gradeSearches(parsed, { minTurnsAfter: 3 });
    assert.equal(graded.length, 1);
    assert.equal(immature, 1);
    assert.deepEqual(graded[0].helpful.sort(), ['c-ident', 'c-path']);
    assert.deepEqual(graded[0].irrelevant, ['c-prose']);
  });

  it('final grades everything', () => {
    const { graded, immature } = gradeSearches(parsed, { final: true });
    assert.equal(graded.length, 2);
    assert.equal(immature, 0);
    assert.deepEqual(graded[1].irrelevant, ['c-prose']);
  });

  it('never infers corrected', () => {
    const { graded } = gradeSearches(parsed, { final: true });
    for (const g of graded) assert.ok(!('corrected' in g));
  });
});

describe('gradeTranscript', () => {
  it('records outcomes through storage once and remembers what it graded', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const transcript = join(dir, 'session.jsonl');
      writeFileSync(transcript, [
        assistant([searchCall('tu-x', 'q')]),
        toolResult('tu-x', results([PATH_CHUNK, PROSE_CHUNK])),
        assistant([{ type: 'text', text: 'see scripts/nested-session.sh' }]),
        assistant([{ type: 'text', text: '.' }]),
        assistant([{ type: 'text', text: '.' }]),
      ].join('\n'));

      const config = loadConfig({ dataDir: dir, enableFSRS: false });
      const chunks = new Map<string, Record<string, unknown>>([
        ['c-path', { id: 'c-path', importance: 0.5, recallOutcomes: [], relatedMemories: [] }],
        ['c-prose', { id: 'c-prose', importance: 0.5, recallOutcomes: [], relatedMemories: [] }],
      ]);
      const fake = {
        getChunk: async (id: string) => chunks.get(id) ?? null,
        updateChunk: async (id: string, patch: Record<string, unknown>) => { chunks.set(id, { ...chunks.get(id), ...patch }); },
      } as unknown as Storage;
      let opened = 0;
      const open = async () => { opened++; return fake; };

      const first = await gradeTranscript(config, open, transcript, 'sess-1');
      assert.equal(first.graded, 1);
      assert.equal(first.helpful, 1);
      assert.equal(first.irrelevant, 1);
      assert.equal(opened, 1);
      assert.equal((chunks.get('c-path') as { importance: number }).importance, 0.55);
      assert.equal((chunks.get('c-prose') as { importance: number }).importance, 0.45);
      assert.equal((chunks.get('c-path') as { recallOutcomes: unknown[] }).recallOutcomes.length, 1);
      assert.ok(readGradedState(dir, 'sess-1').has('tu-x'));

      const second = await gradeTranscript(config, open, transcript, 'sess-1');
      assert.equal(second.graded, 0);
      assert.equal(second.alreadyGraded, 1);
      assert.equal(opened, 1, 'storage is not opened when there is nothing new to record');
    } finally {
      cleanup();
    }
  });

  it('dry run records nothing and remembers nothing', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const transcript = join(dir, 's.jsonl');
      writeFileSync(transcript, [
        assistant([searchCall('tu-d', 'q')]),
        toolResult('tu-d', results([PATH_CHUNK])),
        assistant([{ type: 'text', text: 'scripts/nested-session.sh' }]),
      ].join('\n'));
      const config = loadConfig({ dataDir: dir, enableFSRS: false });
      let opened = 0;
      const s = await gradeTranscript(config, async () => { opened++; throw new Error('should not open'); }, transcript, 'sess-2', { final: true, dryRun: true });
      assert.equal(s.graded, 1);
      assert.equal(opened, 0);
      assert.equal(readGradedState(dir, 'sess-2').size, 0);
    } finally {
      cleanup();
    }
  });
});
