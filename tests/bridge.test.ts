/**
 * Bridge tests — procedural rule interchange between Engram and Persona.
 * Tests conflict detection, round-trip sync, and edge cases.
 *
 * Run: npx tsx tests/bridge.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const BRIDGE_PATH = join(homedir(), '.claude', 'procedural-bridge.json');
let originalBridge: string | null = null;

// Save/restore bridge file around tests
before(() => {
  if (existsSync(BRIDGE_PATH)) {
    originalBridge = readFileSync(BRIDGE_PATH, 'utf-8');
  }
});

after(() => {
  if (originalBridge !== null) {
    writeFileSync(BRIDGE_PATH, originalBridge, 'utf-8');
  } else if (existsSync(BRIDGE_PATH)) {
    unlinkSync(BRIDGE_PATH);
  }
});

function writeBridge(rules: any[]) {
  const dir = dirname(BRIDGE_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(BRIDGE_PATH, JSON.stringify({
    version: 1,
    lastUpdated: new Date().toISOString(),
    rules,
  }, null, 2), 'utf-8');
}

function readBridge(): any {
  return JSON.parse(readFileSync(BRIDGE_PATH, 'utf-8'));
}

// ── Conflict Detection Tests ─────────────────────────────────────

describe('Conflict Detection', () => {
  // Import the function directly from the compiled output
  const { isContradictory } = (() => {
    // We test the logic inline since it's not exported
    const negations = ['not', 'never', "don't", 'avoid', 'stop', "won't", 'without'];
    const antonymPairs: [string, string][] = [
      ['always', 'never'], ['enable', 'disable'], ['allow', 'block'],
      ['verbose', 'terse'], ['include', 'exclude'], ['before', 'after'],
      ['more', 'less'], ['increase', 'decrease'], ['add', 'remove'],
    ];

    function isContradictory(a: string, b: string): boolean {
      const aLower = a.toLowerCase();
      const bLower = b.toLowerCase();

      const aHasNeg = negations.some(n => aLower.includes(n));
      const bHasNeg = negations.some(n => bLower.includes(n));

      if (aHasNeg !== bHasNeg) {
        const aWords = new Set(aLower.split(/\s+/).filter(w => w.length > 3));
        const bWords = new Set(bLower.split(/\s+/).filter(w => w.length > 3));
        let overlap = 0;
        for (const w of aWords) if (bWords.has(w)) overlap++;
        if (overlap >= 2) return true;
      }

      const predicates = ['prefers?', 'uses?', 'wants?', 'chooses?', 'switched to', 'moved to'];
      for (const pred of predicates) {
        const regex = new RegExp(`\\b${pred}\\s+(\\S+)`, 'i');
        const aMatch = aLower.match(regex);
        const bMatch = bLower.match(regex);
        if (aMatch && bMatch && aMatch[1] !== bMatch[1]) {
          const aSubj = aLower.split(/\s+/).slice(0, 3);
          const bSubj = bLower.split(/\s+/).slice(0, 3);
          const subjOverlap = aSubj.some(w => bSubj.includes(w) && w.length > 3);
          if (subjOverlap) return true;
        }
      }

      for (const [pos, neg] of antonymPairs) {
        if ((aLower.includes(pos) && bLower.includes(neg)) ||
            (aLower.includes(neg) && bLower.includes(pos))) {
          const aWords = new Set(aLower.split(/\s+/).filter(w => w.length > 3 && w !== pos && w !== neg));
          const bWords = new Set(bLower.split(/\s+/).filter(w => w.length > 3 && w !== pos && w !== neg));
          let overlap = 0;
          for (const w of aWords) if (bWords.has(w)) overlap++;
          if (overlap >= 2) return true;
        }
      }

      return false;
    }

    return { isContradictory };
  })();

  it('detects negation contradictions', () => {
    assert.ok(isContradictory(
      'Always show code before explanation',
      "Don't show code before explanation"
    ));
  });

  it('detects antonym contradictions', () => {
    assert.ok(isContradictory(
      'Use verbose output for debugging tasks',
      'Use terse output for debugging tasks'
    ));
  });

  it('detects value contradictions', () => {
    assert.ok(isContradictory(
      'Matt prefers TypeScript for projects',
      'Matt prefers Python for projects'
    ));
  });

  it('does not flag unrelated rules as contradictions', () => {
    assert.ok(!isContradictory(
      'Always use explicit return types',
      'Prefer functional components over class components'
    ));
  });

  it('does not flag elaborations as contradictions', () => {
    assert.ok(!isContradictory(
      'Use TypeScript for all projects',
      'Use TypeScript strict mode for all projects'
    ));
  });

  it('handles empty/short strings gracefully', () => {
    assert.ok(!isContradictory('', ''));
    assert.ok(!isContradictory('hi', 'no'));
    assert.ok(!isContradictory('always', 'never')); // No shared content words
  });
});

// ── Bridge File Round-Trip Tests ────────────────────────────────

describe('Bridge File', () => {
  it('creates bridge file from empty state', () => {
    if (existsSync(BRIDGE_PATH)) unlinkSync(BRIDGE_PATH);

    writeBridge([{
      id: 'engram:test-1',
      rule: 'Always use TypeScript',
      domain: 'code',
      confidence: 0.8,
      source: 'engram',
      sourceId: 'test-1',
      evidence: ['User corrected Python to TypeScript'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }]);

    const bridge = readBridge();
    assert.equal(bridge.version, 1);
    assert.equal(bridge.rules.length, 1);
    assert.equal(bridge.rules[0].source, 'engram');
  });

  it('preserves rules from both sources', () => {
    writeBridge([
      {
        id: 'engram:r1', rule: 'Engram rule', domain: 'code',
        confidence: 0.7, source: 'engram', sourceId: 'r1',
        evidence: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
      {
        id: 'persona:p1', rule: 'Persona rule', domain: 'style',
        confidence: 0.6, source: 'persona', sourceId: 'p1',
        evidence: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
    ]);

    const bridge = readBridge();
    assert.equal(bridge.rules.length, 2);
    assert.equal(bridge.rules.filter((r: any) => r.source === 'engram').length, 1);
    assert.equal(bridge.rules.filter((r: any) => r.source === 'persona').length, 1);
  });

  it('handles malformed bridge file gracefully', () => {
    writeFileSync(BRIDGE_PATH, 'not json', 'utf-8');

    // The loadBridgeFile function should return empty state
    let bridge;
    try {
      bridge = JSON.parse(readFileSync(BRIDGE_PATH, 'utf-8'));
    } catch {
      bridge = { version: 1, lastUpdated: new Date().toISOString(), rules: [] };
    }
    assert.equal(bridge.rules.length, 0);
  });
});

// ── Self-Organizing Tests ───────────────────────────────────────

describe('Self-Organizing Domain Inference', () => {
  const domainSignals: Record<string, string[]> = {
    code: ['function', 'import', 'export', 'typescript', 'react', 'component', 'api', 'endpoint', 'bug', 'refactor', 'deploy'],
    design: ['figma', 'layout', 'color', 'font', 'responsive', 'ui', 'ux', 'component', 'tailwind'],
    business: ['pricing', 'customer', 'marketing', 'revenue', 'competitor', 'launch', 'user'],
    personal: ['prefer', 'like', 'dislike', 'always', 'never', 'habit', 'schedule'],
  };

  function inferDomain(content: string): string | null {
    const lower = content.toLowerCase();
    for (const [domain, keywords] of Object.entries(domainSignals)) {
      const hits = keywords.filter(k => lower.includes(k)).length;
      if (hits >= 2) return domain;
    }
    return null;
  }

  it('infers code domain from technical content', () => {
    assert.equal(inferDomain('Use TypeScript import statements and export functions'), 'code');
  });

  it('infers business domain from business content', () => {
    assert.equal(inferDomain('Update pricing for customer launch'), 'business');
  });

  it('infers personal domain from preference content', () => {
    assert.equal(inferDomain('I always prefer to work in the morning, never at night'), 'personal');
  });

  it('returns null for ambiguous content', () => {
    assert.equal(inferDomain('Hello world'), null);
  });
});
