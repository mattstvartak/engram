#!/usr/bin/env node

/**
 * LongMemEval Benchmark -- same dataset as MemPalace
 *
 * Dataset: 500 questions across 6 types, ~53 sessions per question.
 * Source:  https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned
 *
 * MemPalace scores:
 *   Raw ChromaDB:          96.6% R@5  (zero API)
 *   Hybrid v4 (no rerank): 98.4% R@5  (zero API, held-out 450)
 *   Hybrid v4 + Haiku:     100%  R@5  (Haiku rerank)
 *
 * Usage:
 *   # 1. Download dataset (~277 MB)
 *   curl -fsSL -o benchmarks/data/longmemeval_s_cleaned.json \
 *     https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json
 *
 *   # 2. Run benchmark
 *   npm run bench:longmemeval
 *   npm run bench:longmemeval -- --limit 50        # quick test with 50 questions
 *   npm run bench:longmemeval -- --verbose          # per-question output
 */

import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Storage } from '../src/storage.js';
import { loadConfig } from '../src/config.js';
import { embed, isLlmAvailable } from '../src/llm.js';
import { search, selectRelevant } from '../src/search.js';
import type { SmartMemoryConfig, SearchResult } from '../src/types.js';
import type { StoredChunk } from '../src/storage.js';
import { randomUUID } from 'node:crypto';

// ── Types ───────────────────────────────────────────────────────────

interface LMEEntry {
  question_id: string;
  question_type: string;
  question: string;
  answer: string | number;
  question_date: string;
  haystack_session_ids: string[];
  haystack_dates: string[];
  haystack_sessions: Array<Array<{ role: string; content: string; has_answer?: boolean }>>;
  answer_session_ids: string[];
}

interface QuestionResult {
  questionId: string;
  questionType: string;
  question: string;
  recall5: number;
  recall10: number;
  ndcg5: number;
  ndcg10: number;
  latencyMs: number;
  answerSessionIds: string[];
  retrievedSessionIds: string[];
}

// ── Metrics ─────────────────────────────────────────────────────────

function recallAtK(retrieved: string[], relevant: string[], k: number): number {
  if (relevant.length === 0) return 1;
  const topK = new Set(retrieved.slice(0, k));
  const found = relevant.filter(id => topK.has(id)).length;
  return found > 0 ? 1 : 0; // Binary recall: did we find ANY answer session in top K?
}

function ndcgAtK(retrieved: string[], relevant: string[], k: number): number {
  const relevantSet = new Set(relevant);
  let dcg = 0;
  const topK = retrieved.slice(0, k);
  for (let i = 0; i < topK.length; i++) {
    if (relevantSet.has(topK[i])) {
      dcg += 1 / Math.log2(i + 2);
    }
  }
  let idcg = 0;
  for (let i = 0; i < Math.min(relevant.length, k); i++) {
    idcg += 1 / Math.log2(i + 2);
  }
  return idcg === 0 ? 0 : dcg / idcg;
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose') || args.includes('-v');
  const limitArg = args.find((_, i) => args[i - 1] === '--limit');
  const limit = limitArg ? parseInt(limitArg) : undefined;
  const useRerank = args.includes('--rerank');

  // Find dataset
  const dataPath = join(import.meta.dirname ?? '.', 'data', 'longmemeval_s_cleaned.json');
  if (!existsSync(dataPath)) {
    console.error('Dataset not found at:', dataPath);
    console.error('');
    console.error('Download it first:');
    console.error('  mkdir -p benchmarks/data');
    console.error('  curl -fsSL -o benchmarks/data/longmemeval_s_cleaned.json \\');
    console.error('    https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json');
    process.exit(1);
  }

  console.error('Loading dataset...');
  const raw = readFileSync(dataPath, 'utf-8');
  let dataset: LMEEntry[] = JSON.parse(raw);
  console.error(`Loaded ${dataset.length} questions`);

  if (limit) {
    dataset = dataset.slice(0, limit);
    console.error(`Limited to ${dataset.length} questions`);
  }

  // Process each question independently (like MemPalace does)
  const results: QuestionResult[] = [];
  const byType: Record<string, QuestionResult[]> = {};

  // Warm up embedding model
  console.error('Warming up embedding model...');
  await embed(loadConfig(), 'warmup');
  console.error('Model ready.\n');

  for (let qi = 0; qi < dataset.length; qi++) {
    const entry = dataset[qi];

    if (verbose || qi % 50 === 0) {
      console.error(`[${qi + 1}/${dataset.length}] ${entry.question_type}: ${entry.question.slice(0, 60)}...`);
    }

    // Create isolated storage for this question
    const benchDir = join(tmpdir(), `lme-bench-${Date.now()}-${qi}`);
    mkdirSync(benchDir, { recursive: true });

    const config: SmartMemoryConfig = {
      ...loadConfig({ dataDir: benchDir }),
      dataDir: benchDir,
      maxRecallChunks: 10,
      maxRecallTokens: 50000, // Don't limit by tokens for benchmark
    };

    const storage = new Storage(benchDir);
    await storage.ensureReady();

    // Ingest sessions as whole documents (same approach as MemPalace)
    const sessionIdMap = new Map<string, string>(); // chunkId -> sessionId

    for (let si = 0; si < entry.haystack_sessions.length; si++) {
      const session = entry.haystack_sessions[si];
      const sessionId = entry.haystack_session_ids[si];
      const sessionDate = entry.haystack_dates[si] ?? '';

      // Concatenate session into a single document
      const sessionText = session
        .map(m => `${m.role}: ${m.content}`)
        .join('\n');

      if (sessionText.length < 10) continue;

      const chunkId = randomUUID();
      sessionIdMap.set(chunkId, sessionId);

      // Generate embedding
      let embedding: number[] | undefined;
      try {
        embedding = await embed(config, sessionText.slice(0, 2000));
      } catch {
        // Fall back to no embedding
      }

      const chunk: StoredChunk = {
        id: chunkId,
        tier: 'long-term',
        content: sessionText,
        type: 'context',
        cognitiveLayer: 'episodic',
        tags: [],
        domain: '',
        topic: '',
        source: sessionId,
        importance: 0.5,
        sentiment: 'neutral',
        createdAt: sessionDate || new Date().toISOString(),
        lastRecalledAt: null,
        recallCount: 0,
        embedding,
        relatedMemories: [],
        recallOutcomes: [],
      };

      await storage.saveChunk(chunk);
    }

    // Search
    const start = performance.now();
    const searchResults = await search(config, storage, entry.question, 10);

    let selected: SearchResult[];
    if (useRerank && isLlmAvailable()) {
      try {
        selected = await selectRelevant(config, entry.question, searchResults);
      } catch {
        selected = searchResults;
      }
    } else {
      selected = searchResults;
    }
    const latencyMs = performance.now() - start;

    // Map results back to session IDs
    const retrievedSessionIds = selected.map(r => sessionIdMap.get(r.chunk.id) ?? r.chunk.source);

    const recall5 = recallAtK(retrievedSessionIds, entry.answer_session_ids, 5);
    const recall10 = recallAtK(retrievedSessionIds, entry.answer_session_ids, 10);
    const ndcg5 = ndcgAtK(retrievedSessionIds, entry.answer_session_ids, 5);
    const ndcg10 = ndcgAtK(retrievedSessionIds, entry.answer_session_ids, 10);

    const result: QuestionResult = {
      questionId: entry.question_id,
      questionType: entry.question_type,
      question: entry.question,
      recall5,
      recall10,
      ndcg5,
      ndcg10,
      latencyMs: Math.round(latencyMs),
      answerSessionIds: entry.answer_session_ids,
      retrievedSessionIds: retrievedSessionIds.slice(0, 10),
    };

    results.push(result);
    if (!byType[entry.question_type]) byType[entry.question_type] = [];
    byType[entry.question_type].push(result);

    if (verbose) {
      const status = recall5 >= 1 ? 'HIT' : 'MISS';
      console.error(`  [${status}] R@5=${recall5} R@10=${recall10} ${latencyMs.toFixed(0)}ms`);
      if (recall5 < 1) {
        console.error(`  Expected sessions: ${entry.answer_session_ids.join(', ')}`);
        console.error(`  Retrieved: ${retrievedSessionIds.slice(0, 5).join(', ')}`);
      }
    }

    // Cleanup
    try { rmSync(benchDir, { recursive: true, force: true }); } catch { /* noop */ }
  }

  // ── Results ─────────────────────────────────────────────────────

  console.log();
  console.log('='.repeat(76));
  console.log('LONGMEMEVAL BENCHMARK RESULTS');
  console.log('='.repeat(76));
  console.log();

  // Per-type breakdown
  console.log('Per-category:');
  for (const [type, typeResults] of Object.entries(byType).sort((a, b) => a[0].localeCompare(b[0]))) {
    const r5 = typeResults.reduce((s, r) => s + r.recall5, 0) / typeResults.length;
    const r10 = typeResults.reduce((s, r) => s + r.recall10, 0) / typeResults.length;
    const ndcg = typeResults.reduce((s, r) => s + r.ndcg10, 0) / typeResults.length;
    const avgMs = typeResults.reduce((s, r) => s + r.latencyMs, 0) / typeResults.length;
    console.log(`  ${type.padEnd(30)} R@5=${(r5 * 100).toFixed(1).padStart(5)}%  R@10=${(r10 * 100).toFixed(1).padStart(5)}%  NDCG@10=${ndcg.toFixed(3)}  avg=${avgMs.toFixed(0).padStart(5)}ms  n=${typeResults.length}`);
  }

  console.log();

  // Overall
  const avgR5 = results.reduce((s, r) => s + r.recall5, 0) / results.length;
  const avgR10 = results.reduce((s, r) => s + r.recall10, 0) / results.length;
  const avgNDCG5 = results.reduce((s, r) => s + r.ndcg5, 0) / results.length;
  const avgNDCG10 = results.reduce((s, r) => s + r.ndcg10, 0) / results.length;
  const avgLatency = results.reduce((s, r) => s + r.latencyMs, 0) / results.length;
  const hits5 = results.filter(r => r.recall5 >= 1).length;
  const hits10 = results.filter(r => r.recall10 >= 1).length;

  console.log('-'.repeat(76));
  console.log(`  OVERALL                        R@5=${(avgR5 * 100).toFixed(1)}% (${hits5}/${results.length})  R@10=${(avgR10 * 100).toFixed(1)}% (${hits10}/${results.length})`);
  console.log(`                                 NDCG@5=${avgNDCG5.toFixed(3)}  NDCG@10=${avgNDCG10.toFixed(3)}`);
  console.log(`  Latency                        avg=${avgLatency.toFixed(0)}ms`);
  console.log(`  LLM rerank                     ${useRerank && isLlmAvailable() ? 'enabled' : 'disabled'}`);
  console.log(`  Embedding model                ${process.env.SMART_MEMORY_EMBEDDING_MODEL ?? 'Xenova/all-MiniLM-L6-v2'}`);
  console.log();

  // Comparison
  console.log('Comparison vs MemPalace:');
  console.log(`  MemPalace raw ChromaDB:        R@5=96.6%  (zero API)`);
  console.log(`  MemPalace hybrid v4 (held-out): R@5=98.4%  (zero API)`);
  console.log(`  MemPalace hybrid v4 + Haiku:   R@5=100%   (Haiku rerank)`);
  console.log(`  Smart Memory (this run):       R@5=${(avgR5 * 100).toFixed(1)}%  (${useRerank ? 'with rerank' : 'zero API'})`);
  console.log();
}

main().catch(err => {
  console.error('Benchmark error:', err);
  process.exit(1);
});
