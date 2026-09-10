/**
 * Rule extraction.
 *
 * The rules table had filled with narrative and fragments because the extractor fired on any
 * sentence containing "always" or "never", restatements never matched an existing rule, and
 * nothing recorded which project a rule belonged to. These pin the directive gate, the
 * matcher, scope, and the bridge's idempotence.
 *
 * Run: `npm test` or `node --import tsx --test tests/procedural-extract.test.ts`
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ENGRAM_NO_AUTO_CLOUD = '1';
process.env.ENGRAM_SKIP_EMBED = '1';
delete process.env.OPENROUTER_API_KEY;
delete process.env.ENGRAM_LLM_BASE_URL;

import { directiveFrom, splitDirective, scopeFromLabel, sentencesOf, findMatchingRule, ruleSimilarity, normalizeScope, extractRules, formatRulesForPrompt } from '../src/procedural.js';
import { importRulesFromBridge } from '../src/procedural-bridge.js';
import { Storage } from '../src/storage.js';
import { loadConfig } from '../src/config.js';
import type { ProceduralRule } from '../src/types.js';

function tmpDir() {
  const dir = mkdtempSync(join(tmpdir(), 'engram-rules-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function rule(text: string, over: Partial<ProceduralRule> = {}): ProceduralRule {
  return { id: `r-${Math.random().toString(36).slice(2, 8)}`, rule: text, domain: 'general', confidence: 0.5, reinforcements: 0, contradictions: 0, evidence: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...over };
}

describe('directiveFrom', () => {
  const accepted = [
    'Never propose a physical or destructive action on an unverified hypothesis.',
    'RULE (Matt, 2026-08-19): In the DB7001 Jira workflow, ALWAYS use the "Prod UAT" status, never the plain "UAT" status.',
    'Rule set by Matt: write commit messages like a human.',
    'Matt prefers pnpm for package management in monorepos.',
    'HARD RULE (repeat correction, 2026-09-09): NEVER call resize_window during Claude-in-Chrome automation.',
    'From now on transition to Prod UAT after the production deploy completes.',
    'Do not push any changes without being asked in that message.',
    'Stave copy rule (Matt, 2026-07-13): NEVER call customers "drinkers" in any Stave-facing copy.',
    'ATTRIBUTION RULE (universal, confirmed 2026-08-27): Never add an AI co-authorship trailer to a commit.',
    '"Make long lists virtualized lists" is a standing expectation for any list that can grow.',
    'Send one agent once we are done to update old docs and remove stale ones.',
    'chaos-clash naming (2026-06-24, Matt): NEVER call the drop-block hazard a "Thwomp"; it is the "Crusher".',
  ];
  for (const s of accepted) it(`accepts: ${s.slice(0, 50)}`, () => assert.ok(directiveFrom(s), s));

  const rejected = [
    'The fix was never half-applied.',
    'corpse_fx.gd is render-only: not in network_sync, never saved, headless-gated at its spawn site.',
    'Why Laura didn\'t see it (most to least likely): (1) SHOW-ONCE per session writes a sessionStorage key.',
    'Stave CORRECTION to the tenant-creation bug dating (2026-08-31): the ensureStandardPages hook has NEVER worked.',
    'Planning is never the thing to cut; a planner agent per unit is what is wasteful.',
    'it bans AI references entirely, not just co-author trailers.',
    'Why: during a mic dropout I proposed three confident fixes in a row that were each wrong.',
    'a question is a question.',
    'It is an AssistProvider, never listed in image provider pickers.',
  ];
  for (const s of rejected) it(`rejects: ${s.slice(0, 50)}`, () => assert.equal(directiveFrom(s), null, s));

  it('strips labels and enumeration from what it keeps', () => {
    assert.equal(directiveFrom('(2) Rule from Matt: Never let agents inherit the session model.'), 'Never let agents inherit the session model.');
  });
});

describe('matching restatements', () => {
  it('merges restatements that share their content words', () => {
    const deploy = [rule('Reinforced rule from Matt (2026-09-09, said twice): never push or deploy unless he asks in that message.')];
    assert.equal(findMatchingRule('Rule from Matt (2026-09-09, franchiseo-pryzm-demo): do NOT push or deploy to production unless he explicitly says to.', deploy), 0);
    const resize = [rule('RULE (Matt, 2026-07-06): Never resize his browser windows during claude-in-chrome automation (no resize_window).')];
    assert.equal(findMatchingRule('HARD RULE (repeat correction, 2026-09-09): NEVER call resize_window or otherwise change the size of his Chrome browser window during automation.', resize), 0);
  });
  it('does not claim a semantic restatement with different vocabulary; that is the LLM path', () => {
    // "close team members once they complete" and "shut down a subagent the moment it completes"
    // share three content words of seven. A token matcher that merged these would merge
    // unrelated rules too, so it must not.
    const existing = [rule('Rule from Matt (2026-09-08): always close team members / subagents once they have completed their task.')];
    assert.equal(findMatchingRule('ALWAYS shut down a subagent/teammate the moment it completes its task.', existing), -1);
  });
  it('does not merge rules that merely share common words', () => {
    const existing = [rule('Never resize his browser window during automation.')];
    assert.equal(findMatchingRule('Never deploy to production without being asked.', existing), -1);
  });
  it('similarity ignores dates, quotes and names', () => {
    assert.ok(ruleSimilarity('RULE (Matt, 2026-07-06): Never resize his browser windows during claude-in-chrome automation (no resize_window).', 'Browser-automation rule from Matt (2026-08-05): never resize his browser window during testing (no resize_window).') >= 0.45);
  });
});

describe('scope', () => {
  it('maps how-I-work domains to everywhere and project domains to themselves', () => {
    assert.equal(normalizeScope('global'), '');
    assert.equal(normalizeScope('workflow'), '');
    assert.equal(normalizeScope(undefined), '');
    assert.equal(normalizeScope('Argos'), 'argos');
    assert.equal(normalizeScope('elevate-pryzm'), 'elevate-pryzm');
  });

  it('a rule extracted under a project keeps that scope and only shows for it', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const config = loadConfig({ dataDir: dir });
      const storage = new Storage(dir);
      await storage.ensureReady();
      await extractRules(config, storage, [{ role: 'user', content: 'Stave copy rule: never call customers "drinkers" in any Stave-facing copy.' }], undefined, { scope: 'stave' });
      await extractRules(config, storage, [{ role: 'user', content: 'Rule from Matt: never add an AI co-authorship trailer to a commit.' }], undefined, { scope: 'global' });
      const rules = await storage.getRules();
      assert.equal(rules.length, 2);
      assert.deepEqual(rules.map(r => r.scope).sort(), ['', 'stave']);
      const forStave = await formatRulesForPrompt(storage, 'stave');
      const forArgos = await formatRulesForPrompt(storage, 'argos');
      assert.match(forStave, /drinkers/);
      assert.match(forStave, /co-authorship/);
      assert.doesNotMatch(forArgos, /drinkers/);
      assert.match(forArgos, /co-authorship/);
    } finally { cleanup(); }
  });
});

describe('bridge import is idempotent', () => {
  it('bumps a matched rule once for a given bridge entry, not on every pass', async () => {
    const { dir, cleanup } = tmpDir();
    const bridge = join(dir, 'bridge.json');
    process.env.PRZM_MEMORY_BRIDGE_PATH = bridge;
    try {
      const storage = new Storage(dir);
      await storage.ensureReady();
      await storage.saveRule(rule('Never resize the browser window during automation.', { updatedAt: '2026-01-01T00:00:00Z' }));
      writeFileSync(bridge, JSON.stringify({ version: 1, lastUpdated: '2026-02-01T00:00:00Z', rules: [{
        id: 'persona:1', rule: 'Never resize the browser window during automation.', domain: 'general', confidence: 0.6,
        source: 'persona', sourceId: '1', evidence: ['said twice'], createdAt: '2026-01-15T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z',
      }] }));
      const first = await importRulesFromBridge(storage);
      const second = await importRulesFromBridge(storage);
      assert.equal(first.reinforced, 1);
      assert.equal(second.reinforced, 0, 'unchanged bridge evidence must not reinforce again');
      const [r] = await storage.getRules();
      assert.equal(r.reinforcements, 1);
      assert.equal(r.confidence, 0.55);
    } finally {
      delete process.env.PRZM_MEMORY_BRIDGE_PATH;
      cleanup();
    }
  });
});

describe('sentence splitting', () => {
  it('does not break inside backticks or after e.g.', () => {
    const out = sentencesOf('Keep required file headers (e.g. the @copyright block). Ask him to run it with the `! <command>` prefix.');
    assert.deepEqual(out, ['Keep required file headers (e.g. the @copyright block).', 'Ask him to run it with the `! <command>` prefix.']);
  });
  it('breaks on semicolons so a chained correction yields two directives', () => {
    const out = sentencesOf('Do not leave finished agents idle in the session; stop them as soon as their report is in.');
    assert.equal(out.length, 2);
    assert.equal(directiveFrom(out[0]), 'Do not leave finished agents idle in the session');
  });
});

describe('scope from the label', () => {
  const known = ['stave', 'elevate', 'elevate-pryzm', 'argos', 'chaos-clash'];
  it('reads the project off the label when the memory had no domain', () => {
    const split = splitDirective('Stave-admin git/deploy workflow rule (Matt set this): ALWAYS work off the development branch.');
    assert.ok(split);
    assert.equal(scopeFromLabel(split.label, known), 'stave');
    assert.equal(scopeFromLabel('chaos-clash naming (2026-06-24, Matt):', known), 'chaos-clash');
  });
  it('prefers the longest matching slug and finds none in a plain label', () => {
    assert.equal(scopeFromLabel('elevate-pryzm workspace rule:', known), 'elevate-pryzm');
    assert.equal(scopeFromLabel('Rule from Matt (2026-09-09):', known), '');
  });
  it('an extraction under no scope still scopes a rule whose label names a project', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const config = loadConfig({ dataDir: dir });
      const storage = new Storage(dir);
      await storage.ensureReady();
      await extractRules(config, storage, [{ role: 'user', content: 'Stave copy rule (Matt): never call customers "drinkers" in owner-facing copy.' }], undefined, { scope: '', knownScopes: known, seedConfidence: 0.68 });
      const [r] = await storage.getRules();
      assert.equal(r.scope, 'stave');
      assert.equal(r.confidence, 0.68);
    } finally { cleanup(); }
  });
});

describe('cut-off text and carried labels', () => {
  it('refuses to mint a rule from a sentence the chunker cut mid-way', () => {
    assert.equal(directiveFrom('Keep required file headers (e.g.'), null);
    assert.equal(directiveFrom('Never promote to stage (preview builds'), null);
    assert.ok(directiveFrom('Keep required file headers (e.g. the copyright block).'));
  });
  it('scopes later sentences of a memory by the label on its first sentence', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const config = loadConfig({ dataDir: dir });
      const storage = new Storage(dir);
      await storage.ensureReady();
      await extractRules(config, storage, [{ role: 'user', content: 'Stave-admin workflow rule (Matt set this): ALWAYS work off the development branch. NEVER promote to stage without explicit permission.' }], undefined, { scope: '', knownScopes: ['stave'] });
      const rules = await storage.getRules();
      assert.equal(rules.length, 2);
      assert.deepEqual(rules.map(r => r.scope), ['stave', 'stave']);
    } finally { cleanup(); }
  });
});
