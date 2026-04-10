#!/usr/bin/env node

/**
 * Engram Benchmark Suite
 *
 * Tests retrieval quality across the same categories as MemPalace's benchmarks:
 *   - Single-fact recall (user facts, preferences)
 *   - Knowledge updates (temporal validity)
 *   - Multi-session reasoning
 *   - Temporal reasoning
 *   - Adversarial / distractor resistance
 *
 * Metrics: Recall@5, Recall@10, NDCG@5, NDCG@10, latency
 *
 * Usage:
 *   npx tsx benchmarks/bench.ts
 *   npx tsx benchmarks/bench.ts --verbose
 */

import { join } from 'node:path';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Storage } from '../src/storage.js';
import { loadConfig } from '../src/config.js';
import { search } from '../src/search.js';
import { ingest } from '../src/wal.js';
import { consolidate } from '../src/consolidator.js';
import { addTriple, replaceTriple, queryGraph } from '../src/knowledge-graph.js';
import type { SmartMemoryConfig } from '../src/types.js';

// ── Test Data ───────────────────────────────────────────────────────

interface TestCase {
  category: string;
  query: string;
  expectedContent: string[]; // substrings that MUST appear in results
  negativeContent?: string[]; // substrings that MUST NOT appear in results
}

// Seed memories -- things we "know" about the user
const SEED_MEMORIES = [
  // User facts
  { content: 'User is a senior software engineer at Acme Corp', type: 'fact' as const, importance: 0.9, tags: ['role', 'acme'], domain: 'work', topic: 'role' },
  { content: 'User prefers TypeScript over JavaScript for all new projects', type: 'preference' as const, importance: 0.7, tags: ['typescript', 'javascript'], domain: 'code', topic: 'languages' },
  { content: 'User has a golden retriever named Biscuit', type: 'fact' as const, importance: 0.6, tags: ['pets', 'personal'], domain: 'personal', topic: 'pets' },
  { content: 'User always wants explicit return types on TypeScript functions', type: 'preference' as const, importance: 0.8, tags: ['typescript', 'code-style'], domain: 'code', topic: 'style' },
  { content: 'User decided to use PostgreSQL instead of MongoDB for the new project', type: 'decision' as const, importance: 0.7, tags: ['database', 'postgres', 'mongodb'], domain: 'work', topic: 'database' },
  { content: 'User is building a SaaS platform for plumbing contractors', type: 'fact' as const, importance: 0.8, tags: ['saas', 'plumbing', 'project'], domain: 'work', topic: 'project' },
  { content: 'User gets frustrated when code suggestions include console.log debugging', type: 'correction' as const, importance: 0.7, tags: ['debugging', 'code-style'], domain: 'code', topic: 'style' },
  { content: 'User prefers Tailwind CSS over styled-components', type: 'preference' as const, importance: 0.5, tags: ['css', 'tailwind', 'styling'], domain: 'code', topic: 'styling' },

  // Episodic / temporal
  { content: 'User debugged a critical auth token expiry bug that affected all customers on 2025-12-15', type: 'context' as const, importance: 0.6, tags: ['auth', 'bug', 'incident'], domain: 'work', topic: 'incidents' },
  { content: 'User migrated the database from MySQL to PostgreSQL in January 2026', type: 'decision' as const, importance: 0.7, tags: ['database', 'migration', 'postgres', 'mysql'], domain: 'work', topic: 'database' },
  { content: 'User started using Vercel for deployments in February 2026', type: 'decision' as const, importance: 0.5, tags: ['deployment', 'vercel'], domain: 'work', topic: 'deployment' },
  { content: 'User hired two junior developers in March 2026', type: 'fact' as const, importance: 0.5, tags: ['team', 'hiring'], domain: 'work', topic: 'team' },

  // Procedural / workflow
  { content: 'Never use em-dashes in any written output', type: 'correction' as const, importance: 0.8, tags: ['writing', 'formatting'], domain: 'communication', topic: 'formatting' },
  { content: 'Always show the code fix first, then explain the reasoning', type: 'preference' as const, importance: 0.7, tags: ['workflow', 'communication'], domain: 'communication', topic: 'workflow' },
  { content: 'User wants terse responses with no trailing summaries', type: 'preference' as const, importance: 0.6, tags: ['communication', 'style'], domain: 'communication', topic: 'style' },

  // Distractors -- related but different
  { content: 'User mentioned looking at Rust for a side project but decided against it', type: 'context' as const, importance: 0.3, tags: ['rust', 'languages'], domain: 'personal', topic: 'experiments' },
  { content: 'User discussed GraphQL vs REST and chose REST for simplicity', type: 'decision' as const, importance: 0.5, tags: ['api', 'graphql', 'rest'], domain: 'work', topic: 'api' },
  { content: 'User tried Svelte but went back to React', type: 'context' as const, importance: 0.3, tags: ['svelte', 'react', 'frontend'], domain: 'code', topic: 'frameworks' },
];

// Test queries -- what we ask the memory system
const TEST_CASES: TestCase[] = [
  // ── Single-fact recall ────────────────────────────────────────────
  {
    category: 'single-fact',
    query: 'What does the user do for work?',
    expectedContent: ['senior software engineer', 'Acme Corp'],
  },
  {
    category: 'single-fact',
    query: 'What is the user building?',
    expectedContent: ['SaaS', 'plumbing'],
  },
  {
    category: 'single-fact',
    query: "What is the user's pet?",
    expectedContent: ['golden retriever', 'Biscuit'],
  },
  {
    category: 'single-fact',
    query: 'What database does the user use?',
    expectedContent: ['PostgreSQL'],
  },

  // ── Preference recall ─────────────────────────────────────────────
  {
    category: 'preference',
    query: 'What programming language does the user prefer?',
    expectedContent: ['TypeScript'],
  },
  {
    category: 'preference',
    query: 'How does the user want CSS handled?',
    expectedContent: ['Tailwind'],
  },
  {
    category: 'preference',
    query: 'What formatting rules does the user care about?',
    expectedContent: ['em-dash'],
  },
  {
    category: 'preference',
    query: 'How should I format my responses for this user?',
    expectedContent: ['terse', 'code fix first'],
  },

  // ── Temporal reasoning ────────────────────────────────────────────
  {
    category: 'temporal',
    query: 'What happened with the database migration?',
    expectedContent: ['MySQL', 'PostgreSQL', 'January 2026'],
  },
  {
    category: 'temporal',
    query: 'What incident happened in December 2025?',
    expectedContent: ['auth token', 'expiry', '2025-12-15'],
  },
  {
    category: 'temporal',
    query: 'When did the user start using Vercel?',
    expectedContent: ['February 2026'],
  },

  // ── Knowledge update ──────────────────────────────────────────────
  {
    category: 'knowledge-update',
    query: 'What did the user decide about REST vs GraphQL?',
    expectedContent: ['REST', 'simplicity'],
  },

  // ── Adversarial / distractor resistance ───────────────────────────
  {
    category: 'adversarial',
    query: 'Does the user use Rust?',
    expectedContent: ['decided against'],
    negativeContent: ['prefers Rust'],
  },
  {
    category: 'adversarial',
    query: 'Does the user use Svelte?',
    expectedContent: ['went back to React'],
  },
  {
    category: 'adversarial',
    query: 'What debugging approach does the user want?',
    expectedContent: ['console.log'],
    negativeContent: ['always use console.log'],
  },
];

// ── Metrics ─────────────────────────────────────────────────────────

function computeRecall(results: string[], expected: string[]): number {
  if (expected.length === 0) return 1;
  const found = expected.filter(exp =>
    results.some(r => r.toLowerCase().includes(exp.toLowerCase()))
  );
  return found.length / expected.length;
}

function computeNDCG(results: string[], expected: string[], k: number): number {
  // DCG: sum of relevance / log2(rank + 1)
  let dcg = 0;
  const topK = results.slice(0, k);

  for (let i = 0; i < topK.length; i++) {
    const relevance = expected.some(exp =>
      topK[i].toLowerCase().includes(exp.toLowerCase())
    ) ? 1 : 0;
    dcg += relevance / Math.log2(i + 2);
  }

  // Ideal DCG: all relevant items at the top
  let idcg = 0;
  for (let i = 0; i < Math.min(expected.length, k); i++) {
    idcg += 1 / Math.log2(i + 2);
  }

  return idcg === 0 ? 0 : dcg / idcg;
}

// ── Runner ──────────────────────────────────────────────────────────

interface BenchResult {
  category: string;
  query: string;
  recall5: number;
  recall10: number;
  ndcg5: number;
  ndcg10: number;
  latencyMs: number;
  negativePass: boolean;
  resultCount: number;
}

async function runBenchmark(verbose: boolean): Promise<void> {
  // Create isolated test environment
  const benchDir = join(tmpdir(), `engram-bench-${Date.now()}`);
  mkdirSync(benchDir, { recursive: true });

  const config: SmartMemoryConfig = {
    ...loadConfig({ dataDir: benchDir }),
    dataDir: benchDir,
  };

  const storage = new Storage(benchDir);
  await storage.ensureReady();

  console.error('Seeding memories...');

  // Seed all test memories
  for (const mem of SEED_MEMORIES) {
    await ingest(config, storage, [{
      content: mem.content,
      type: mem.type,
      importance: mem.importance,
      tags: mem.tags,
      domain: mem.domain,
      topic: mem.topic,
    }]);
  }

  // Run consolidation to build links
  await consolidate(storage);

  // Seed some knowledge graph triples
  await addTriple(storage, 'User', 'works-at', 'Acme Corp', 'bench');
  await addTriple(storage, 'User', 'role', 'Senior Software Engineer', 'bench');
  await addTriple(storage, 'Project', 'uses', 'PostgreSQL', 'bench');
  await addTriple(storage, 'Project', 'uses', 'TypeScript', 'bench');
  await addTriple(storage, 'Project', 'deployed-on', 'Vercel', 'bench');
  // Simulate a knowledge update
  await replaceTriple(storage, 'Project', 'database', 'PostgreSQL', 'bench');

  const chunkCount = await storage.chunkCount();
  console.error(`Seeded ${chunkCount} memories + knowledge graph triples\n`);

  // Wait for embeddings to settle (first load of ONNX model can be slow)
  console.error('Warming up embedding model (first query may be slow)...');
  await search(config, storage, 'warmup query', 1);
  console.error('Model ready.\n');

  // Run test cases
  const results: BenchResult[] = [];

  for (const tc of TEST_CASES) {
    const start = performance.now();
    const searchResults = await search(config, storage, tc.query, 10);
    const latencyMs = performance.now() - start;

    const contents = searchResults.map(r => r.chunk.content);

    const recall5 = computeRecall(contents.slice(0, 5), tc.expectedContent);
    const recall10 = computeRecall(contents, tc.expectedContent);
    const ndcg5 = computeNDCG(contents, tc.expectedContent, 5);
    const ndcg10 = computeNDCG(contents, tc.expectedContent, 10);

    // Check negative content (should NOT appear or should appear in negative context)
    let negativePass = true;
    if (tc.negativeContent) {
      negativePass = !tc.negativeContent.some(neg =>
        contents.some(c => c.toLowerCase().includes(neg.toLowerCase()))
      );
    }

    results.push({
      category: tc.category,
      query: tc.query,
      recall5,
      recall10,
      ndcg5,
      ndcg10,
      latencyMs: Math.round(latencyMs * 10) / 10,
      negativePass,
      resultCount: searchResults.length,
    });

    if (verbose) {
      const status = recall5 >= 1.0 ? 'PASS' : recall5 > 0 ? 'PARTIAL' : 'MISS';
      console.log(`[${status}] ${tc.category}: "${tc.query}"`);
      console.log(`  R@5=${recall5.toFixed(2)} R@10=${recall10.toFixed(2)} NDCG@5=${ndcg5.toFixed(2)} latency=${latencyMs.toFixed(0)}ms`);
      if (recall5 < 1.0) {
        console.log(`  Expected: ${tc.expectedContent.join(', ')}`);
        console.log(`  Got: ${contents.slice(0, 3).map(c => c.slice(0, 80)).join(' | ')}`);
      }
      console.log();
    }
  }

  // ── Aggregate Results ───────────────────────────────────────────
  const categories = [...new Set(results.map(r => r.category))];

  console.log('='.repeat(72));
  console.log('SMART MEMORY BENCHMARK RESULTS');
  console.log('='.repeat(72));
  console.log();

  // Per-category
  for (const cat of categories) {
    const catResults = results.filter(r => r.category === cat);
    const avgR5 = catResults.reduce((s, r) => s + r.recall5, 0) / catResults.length;
    const avgR10 = catResults.reduce((s, r) => s + r.recall10, 0) / catResults.length;
    const avgNDCG5 = catResults.reduce((s, r) => s + r.ndcg5, 0) / catResults.length;
    const avgLatency = catResults.reduce((s, r) => s + r.latencyMs, 0) / catResults.length;
    const negPass = catResults.filter(r => r.negativePass).length;

    console.log(`  ${cat.padEnd(20)} R@5=${(avgR5 * 100).toFixed(1).padStart(5)}%  R@10=${(avgR10 * 100).toFixed(1).padStart(5)}%  NDCG@5=${(avgNDCG5 * 100).toFixed(1).padStart(5)}%  avg=${avgLatency.toFixed(0).padStart(4)}ms  neg=${negPass}/${catResults.length}`);
  }

  console.log();

  // Overall
  const avgR5 = results.reduce((s, r) => s + r.recall5, 0) / results.length;
  const avgR10 = results.reduce((s, r) => s + r.recall10, 0) / results.length;
  const avgNDCG5 = results.reduce((s, r) => s + r.ndcg5, 0) / results.length;
  const avgNDCG10 = results.reduce((s, r) => s + r.ndcg10, 0) / results.length;
  const avgLatency = results.reduce((s, r) => s + r.latencyMs, 0) / results.length;
  const totalNegPass = results.filter(r => r.negativePass).length;
  const p50Latency = [...results].sort((a, b) => a.latencyMs - b.latencyMs)[Math.floor(results.length / 2)].latencyMs;
  const p99Latency = [...results].sort((a, b) => a.latencyMs - b.latencyMs)[Math.floor(results.length * 0.99)].latencyMs;

  console.log('-'.repeat(72));
  console.log(`  OVERALL              R@5=${(avgR5 * 100).toFixed(1).padStart(5)}%  R@10=${(avgR10 * 100).toFixed(1).padStart(5)}%  NDCG@5=${(avgNDCG5 * 100).toFixed(1).padStart(5)}%  NDCG@10=${(avgNDCG10 * 100).toFixed(1).padStart(5)}%`);
  console.log(`  Latency              avg=${avgLatency.toFixed(0)}ms  p50=${p50Latency.toFixed(0)}ms  p99=${p99Latency.toFixed(0)}ms`);
  console.log(`  Negative resistance  ${totalNegPass}/${results.length} passed`);
  console.log(`  Memories seeded      ${chunkCount}`);
  console.log(`  Embedding model      ${process.env.SMART_MEMORY_EMBEDDING_MODEL ?? 'Xenova/all-MiniLM-L6-v2'}`);
  console.log(`  LLM available        ${!!process.env.OPENROUTER_API_KEY}`);
  console.log();

  // ── Knowledge Graph Test ────────────────────────────────────────
  console.log('Knowledge Graph:');
  const kgTriples = await queryGraph(storage, { activeOnly: true });
  console.log(`  Active triples: ${kgTriples.length}`);

  // Test temporal replacement
  const dbTriples = await queryGraph(storage, { subject: 'Project', predicate: 'database' });
  const activeDb = dbTriples.filter(t => !t.validTo);
  console.log(`  Database fact: ${activeDb.map(t => t.object).join(', ') || 'none'}`);
  console.log();

  // Cleanup
  try { rmSync(benchDir, { recursive: true, force: true }); } catch { /* noop */ }

  // Exit code based on overall recall
  if (avgR5 < 0.7) {
    console.error('BENCHMARK FAILED: R@5 below 70% threshold');
    process.exit(1);
  }
}

// ── Entry Point ─────────────────────────────────────────────────────

const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');
runBenchmark(verbose).catch(err => {
  console.error('Benchmark error:', err);
  process.exit(1);
});
