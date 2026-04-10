#!/usr/bin/env node

/**
 * LoCoMo Benchmark -- same dataset as MemPalace
 *
 * Dataset: 1,986 multi-hop QA pairs across 10 long conversations.
 * Source:  https://github.com/snap-research/locomo
 *
 * MemPalace scores:
 *   Hybrid v5 (no rerank):      88.9% R@10  (zero API)
 *   Hybrid v5 + Sonnet rerank:  100%  R@5   (Sonnet rerank, top-50)
 *
 * Categories: single-hop (1), temporal (2), temporal-inference (3),
 *             open-domain (4), adversarial (5)
 *
 * Usage:
 *   # 1. Clone LoCoMo dataset
 *   git clone https://github.com/snap-research/locomo.git benchmarks/data/locomo
 *
 *   # 2. Run benchmark
 *   npm run bench:locomo
 *   npm run bench:locomo -- --limit 200       # quick test
 *   npm run bench:locomo -- --verbose          # per-question output
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

interface LoCoMoConversation {
  sample_id: string;
  conversation: Record<string, any>;
  qa: Array<{
    question: string;
    answer: string;
    category: number; // 1-5
    evidence: string[]; // dialog IDs like "D5:2"
  }>;
}

const CATEGORY_NAMES: Record<number, string> = {
  1: 'single-hop',
  2: 'temporal',
  3: 'temporal-inference',
  4: 'open-domain',
  5: 'adversarial',
};

interface QAResult {
  conversationId: string;
  question: string;
  category: string;
  recall5: number;
  recall10: number;
  latencyMs: number;
  evidenceIds: string[];
  found: boolean;
}

// ── Session extraction ──────────────────────────────────────────────

function parseLocomoDate(dateStr: string): string {
  // Parse "1:56 pm on 8 May, 2023" -> ISO8601
  const match = dateStr.match(/(\d{1,2}):(\d{2})\s*(am|pm)\s+on\s+(\d{1,2})\s+(\w+),?\s+(\d{4})/i);
  if (!match) return new Date().toISOString();

  let hours = parseInt(match[1]);
  const minutes = parseInt(match[2]);
  const ampm = match[3].toLowerCase();
  const day = parseInt(match[4]);
  const monthName = match[5];
  const year = parseInt(match[6]);

  if (ampm === 'pm' && hours !== 12) hours += 12;
  if (ampm === 'am' && hours === 12) hours = 0;

  const monthMap: Record<string, number> = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  };
  const month = monthMap[monthName.toLowerCase()] ?? 0;

  return new Date(year, month, day, hours, minutes).toISOString();
}

function extractSessions(conv: Record<string, any>): Array<{ sessionKey: string; text: string; dialogIds: string[]; dateTime: string }> {
  const sessions: Array<{ sessionKey: string; text: string; dialogIds: string[]; dateTime: string }> = [];

  for (const key of Object.keys(conv)) {
    if (!key.startsWith('session_') || key.includes('date_time')) continue;
    const turns = conv[key];
    if (!Array.isArray(turns)) continue;

    const dialogIds: string[] = [];
    const lines: string[] = [];

    // Get the session date from the companion date_time key
    const dateKey = `${key}_date_time`;
    const rawDate = conv[dateKey] as string | undefined;
    const dateTime = rawDate ? parseLocomoDate(rawDate) : new Date().toISOString();

    for (const turn of turns) {
      if (turn.dia_id) dialogIds.push(turn.dia_id);
      const speaker = turn.speaker ?? 'unknown';
      const text = turn.text ?? '';
      lines.push(`${speaker}: ${text}`);
    }

    if (lines.length > 0) {
      sessions.push({
        sessionKey: key,
        text: lines.join('\n'),
        dialogIds,
        dateTime,
      });
    }
  }

  return sessions;
}

// ── Evidence matching ───────────────────────────────────────────────
// Evidence IDs are like "D5:2" meaning dialog 5, turn 2.
// A session "hits" if it contains any of the evidence dialog IDs.

function sessionContainsEvidence(sessionDialogIds: string[], evidenceIds: string[]): boolean {
  for (const eid of evidenceIds) {
    // Match full ID or just the dialog number
    if (sessionDialogIds.includes(eid)) return true;
    // Also try matching by dialog prefix (e.g. "D5:2" matches session containing "D5:*")
    const dialogNum = eid.split(':')[0];
    if (sessionDialogIds.some(sid => sid.startsWith(dialogNum + ':'))) return true;
  }
  return false;
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose') || args.includes('-v');
  const limitArg = args.find((_, i) => args[i - 1] === '--limit');
  const limit = limitArg ? parseInt(limitArg) : undefined;
  const topK = 10;
  const useRerank = args.includes('--rerank');

  // Find dataset
  const dataPath = join(import.meta.dirname ?? '.', 'data', 'locomo', 'data', 'locomo10.json');
  if (!existsSync(dataPath)) {
    console.error('Dataset not found at:', dataPath);
    console.error('');
    console.error('Clone it first:');
    console.error('  git clone https://github.com/snap-research/locomo.git benchmarks/data/locomo');
    process.exit(1);
  }

  console.error('Loading dataset...');
  const raw = readFileSync(dataPath, 'utf-8');
  const dataset: LoCoMoConversation[] = JSON.parse(raw);
  console.error(`Loaded ${dataset.length} conversations`);

  let totalQA = dataset.reduce((s, c) => s + c.qa.length, 0);
  console.error(`Total QA pairs: ${totalQA}`);

  // Warm up embedding model
  console.error('Warming up embedding model...');
  await embed(loadConfig(), 'warmup');
  console.error('Model ready.\n');

  const results: QAResult[] = [];
  const byCategory: Record<string, QAResult[]> = {};
  let qaCount = 0;

  for (const convo of dataset) {
    console.error(`Processing conversation ${convo.sample_id} (${convo.qa.length} QA pairs)...`);

    // Create isolated storage for this conversation
    const benchDir = join(tmpdir(), `locomo-bench-${Date.now()}-${convo.sample_id}`);
    mkdirSync(benchDir, { recursive: true });

    const config: SmartMemoryConfig = {
      ...loadConfig({ dataDir: benchDir }),
      dataDir: benchDir,
      maxRecallChunks: topK,
      maxRecallTokens: 100000,
    };

    const storage = new Storage(benchDir);
    await storage.ensureReady();

    // Extract and ingest sessions
    const sessions = extractSessions(convo.conversation);
    const sessionChunkMap = new Map<string, { chunkId: string; dialogIds: string[] }>();

    for (const session of sessions) {
      if (session.text.length < 10) continue;

      const chunkId = randomUUID();
      sessionChunkMap.set(chunkId, { chunkId, dialogIds: session.dialogIds });

      let embedding: number[] | undefined;
      try {
        embedding = await embed(config, session.text.slice(0, 2000));
      } catch { /* noop */ }

      const chunk: StoredChunk = {
        id: chunkId,
        tier: 'long-term',
        content: session.text,
        type: 'context',
        cognitiveLayer: 'episodic',
        tags: [],
        domain: '',
        topic: '',
        source: session.sessionKey,
        importance: 0.5,
        sentiment: 'neutral',
        createdAt: session.dateTime,
        lastRecalledAt: null,
        recallCount: 0,
        embedding,
        relatedMemories: [],
        recallOutcomes: [],
      };

      await storage.saveChunk(chunk);
    }

    // Run QA pairs
    const qaToRun = limit ? convo.qa.slice(0, Math.max(1, Math.floor(limit / dataset.length))) : convo.qa;

    for (const qa of qaToRun) {
      qaCount++;
      const catName = CATEGORY_NAMES[qa.category] ?? `cat-${qa.category}`;

      const start = performance.now();
      const searchResults = await search(config, storage, qa.question, topK);

      let selected: SearchResult[];
      if (useRerank && isLlmAvailable()) {
        try {
          selected = await selectRelevant(config, qa.question, searchResults);
        } catch {
          selected = searchResults;
        }
      } else {
        selected = searchResults;
      }
      const latencyMs = performance.now() - start;

      // Check if any retrieved session contains evidence
      const top5Ids = selected.slice(0, 5).map(r => r.chunk.id);
      const top10Ids = selected.slice(0, 10).map(r => r.chunk.id);

      const hit5 = top5Ids.some(cid => {
        const info = sessionChunkMap.get(cid);
        return info ? sessionContainsEvidence(info.dialogIds, qa.evidence) : false;
      });

      const hit10 = top10Ids.some(cid => {
        const info = sessionChunkMap.get(cid);
        return info ? sessionContainsEvidence(info.dialogIds, qa.evidence) : false;
      });

      const result: QAResult = {
        conversationId: convo.sample_id,
        question: qa.question,
        category: catName,
        recall5: hit5 ? 1 : 0,
        recall10: hit10 ? 1 : 0,
        latencyMs: Math.round(latencyMs),
        evidenceIds: qa.evidence,
        found: hit10,
      };

      results.push(result);
      if (!byCategory[catName]) byCategory[catName] = [];
      byCategory[catName].push(result);

      if (verbose && !hit10) {
        console.error(`  [MISS] ${catName}: ${qa.question.slice(0, 60)}...`);
        console.error(`    Evidence: ${qa.evidence.join(', ')}`);
      }
    }

    // Cleanup
    try { rmSync(benchDir, { recursive: true, force: true }); } catch { /* noop */ }
  }

  // ── Results ─────────────────────────────────────────────────────

  console.log();
  console.log('='.repeat(76));
  console.log('LOCOMO BENCHMARK RESULTS');
  console.log('='.repeat(76));
  console.log();

  console.log('Per-category:');
  for (const [cat, catResults] of Object.entries(byCategory).sort((a, b) => a[0].localeCompare(b[0]))) {
    const r5 = catResults.reduce((s, r) => s + r.recall5, 0) / catResults.length;
    const r10 = catResults.reduce((s, r) => s + r.recall10, 0) / catResults.length;
    const avgMs = catResults.reduce((s, r) => s + r.latencyMs, 0) / catResults.length;
    console.log(`  ${cat.padEnd(25)} R@5=${(r5 * 100).toFixed(1).padStart(5)}%  R@10=${(r10 * 100).toFixed(1).padStart(5)}%  avg=${avgMs.toFixed(0).padStart(5)}ms  n=${catResults.length}`);
  }

  console.log();

  const avgR5 = results.reduce((s, r) => s + r.recall5, 0) / results.length;
  const avgR10 = results.reduce((s, r) => s + r.recall10, 0) / results.length;
  const avgLatency = results.reduce((s, r) => s + r.latencyMs, 0) / results.length;
  const hits5 = results.filter(r => r.recall5 >= 1).length;
  const hits10 = results.filter(r => r.recall10 >= 1).length;

  console.log('-'.repeat(76));
  console.log(`  OVERALL                   R@5=${(avgR5 * 100).toFixed(1)}% (${hits5}/${results.length})  R@10=${(avgR10 * 100).toFixed(1)}% (${hits10}/${results.length})`);
  console.log(`  Latency                   avg=${avgLatency.toFixed(0)}ms`);
  console.log(`  LLM rerank                ${useRerank && isLlmAvailable() ? 'enabled' : 'disabled'}`);
  console.log(`  Top-K                     ${topK}`);
  console.log(`  Embedding model           ${process.env.SMART_MEMORY_EMBEDDING_MODEL ?? 'Xenova/all-MiniLM-L6-v2'}`);
  console.log();

  console.log('Comparison vs MemPalace (top-10, no rerank):');
  console.log(`  MemPalace hybrid v5:      R@10=88.9%`);
  console.log(`  Engram (this run):        R@10=${(avgR10 * 100).toFixed(1)}%`);
  console.log();
}

main().catch(err => {
  console.error('Benchmark error:', err);
  process.exit(1);
});
