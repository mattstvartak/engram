/**
 * Handoff / named checkpoint tests.
 *
 * Covers the named-checkpoint extension: write with name, list returns name,
 * read by name resolves the newest match, read by stamp still works, and
 * unknown identifiers surface as null.
 *
 * Run: `npm test` or `node --import tsx --test tests/handoff.test.ts`
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeHandoff, readHandoff, listHandoffs } from '../src/handoff.js';

function tmpDir() {
  const dir = mkdtempSync(join(tmpdir(), 'engram-handoff-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function baseNote(overrides: Partial<Parameters<typeof writeHandoff>[1]> = {}) {
  return {
    sessionId: null,
    reason: 'manual' as const,
    currentTask: 'test task',
    completed: [],
    nextSteps: [],
    openQuestions: [],
    fileRefs: [],
    decisions: [],
    notes: '',
    ...overrides,
  };
}

describe('handoff named checkpoints', () => {
  it('writes and round-trips a named checkpoint', () => {
    const { dir, cleanup } = tmpDir();
    try {
      const written = writeHandoff(dir, baseNote({ name: 'pyre-auth-flow', currentTask: 'wire device-code login' }));
      assert.equal(written.name, 'pyre-auth-flow');

      const loaded = readHandoff(dir, 'pyre-auth-flow');
      assert.ok(loaded);
      assert.equal(loaded.name, 'pyre-auth-flow');
      assert.equal(loaded.currentTask, 'wire device-code login');
    } finally {
      cleanup();
    }
  });

  it('list returns the user-facing name on entries that have one', () => {
    const { dir, cleanup } = tmpDir();
    try {
      writeHandoff(dir, baseNote({ name: 'feature-a', currentTask: 'a' }));
      writeHandoff(dir, baseNote({ currentTask: 'unnamed' }));
      writeHandoff(dir, baseNote({ name: 'feature-b', currentTask: 'b' }));

      const entries = listHandoffs(dir);
      assert.equal(entries.length, 3);
      const named = entries.filter(e => e.name);
      assert.deepEqual(named.map(e => e.name).sort(), ['feature-a', 'feature-b']);

      // Unnamed entry should NOT have a name key set.
      const unnamed = entries.find(e => e.currentTask === 'unnamed');
      assert.ok(unnamed);
      assert.equal(unnamed.name, undefined);
    } finally {
      cleanup();
    }
  });

  it('read by name resolves the newest matching checkpoint when a name is reused', () => {
    const { dir, cleanup } = tmpDir();
    try {
      // Writing the same name twice must not break — newest wins.
      const first = writeHandoff(dir, baseNote({ name: 'reused', currentTask: 'first' }));
      // Force a distinct timestamp so the second file sorts after the first.
      // stampFilename() is second-resolution, so a tiny sleep is enough.
      const start = Date.now();
      while (Date.now() - start < 1100) { /* spin */ }
      const second = writeHandoff(dir, baseNote({ name: 'reused', currentTask: 'second' }));

      assert.notEqual(first.timestamp, second.timestamp);
      const loaded = readHandoff(dir, 'reused');
      assert.ok(loaded);
      assert.equal(loaded.currentTask, 'second');
    } finally {
      cleanup();
    }
  });

  it('read with no identifier returns the latest', () => {
    const { dir, cleanup } = tmpDir();
    try {
      writeHandoff(dir, baseNote({ currentTask: 'older' }));
      const start = Date.now();
      while (Date.now() - start < 1100) { /* spin */ }
      writeHandoff(dir, baseNote({ name: 'newer-named', currentTask: 'newer' }));

      const loaded = readHandoff(dir);
      assert.ok(loaded);
      assert.equal(loaded.currentTask, 'newer');
    } finally {
      cleanup();
    }
  });

  it('read with unknown name returns null', () => {
    const { dir, cleanup } = tmpDir();
    try {
      writeHandoff(dir, baseNote({ name: 'real', currentTask: 'real task' }));
      const loaded = readHandoff(dir, 'does-not-exist');
      assert.equal(loaded, null);
    } finally {
      cleanup();
    }
  });
});

describe('handoff sanitising', () => {
  it('strips a leaked closing tag and the parameter that followed it', () => {
    const { dir, cleanup } = tmpDir();
    try {
      const written = writeHandoff(dir, baseNote({
        currentTask: 'Argos wave two running.</currentTask>\n<parameter name="completed">["a", "b"]',
        completed: ['done thing</completed>\n<parameter name="nextSteps">[]'],
      }));
      assert.equal(written.currentTask, 'Argos wave two running.');
      assert.deepEqual(written.completed, ['done thing']);
      assert.equal(readHandoff(dir)?.currentTask, 'Argos wave two running.');
    } finally {
      cleanup();
    }
  });
});
