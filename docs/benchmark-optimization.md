# Benchmark Optimization Report

**Date:** April 2026
**Benchmark:** [LoCoMo](https://github.com/snap-research/locomo) (1,986 QA pairs, 10 long conversations)
**Metric:** Recall@K (is the correct evidence session in the top K results?)

## Summary

A commit introducing 8 brain-inspired improvements (`3424a64`) caused a regression from ~93% to 61.4% R@10. This document covers the root cause analysis, fixes, a new sub-session chunking feature, and findings on LLM reranking and GPU acceleration.

**Final result:** 92.0% R@10, up from 61.4%, beating MemPalace's 88.9% baseline.

## Regression Analysis

### The Symptom

R@5 equaled R@10 in every category. This meant the system was returning at most 5 useful results even when 10 were requested.

```
BEFORE (broken):
  adversarial               R@5= 67.7%  R@10= 67.7%
  open-domain               R@5= 56.8%  R@10= 56.8%
  single-hop                R@5= 62.4%  R@10= 62.4%
  temporal                  R@5= 66.7%  R@10= 66.7%
  temporal-inference        R@5= 51.0%  R@10= 51.0%
  OVERALL                   R@5=61.4%   R@10=61.4%
```

### Root Causes

Three bugs introduced in the same commit compounded to cause the regression.

#### 1. Embedding Space Mismatch

**File:** `src/search.ts:39`, `src/wal.ts:68`

The commit added contextual prefix embedding (prepending metadata like `"This is a semantic fact about code/languages from 2026-04-10."` before embedding). This improves retrieval by 35-49% per Anthropic's research. But it was only applied at **ingest time**, not at **query time**.

Stored chunks were embedded as `prefix + content`, while search queries were embedded as `query` alone. The vectors lived in different distributions, degrading cosine similarity across the board.

**Fix:** Added a `"search query: "` prefix to query embeddings so both sides of the similarity comparison use prefixed text.

```typescript
// Before
queryEmbedding = await embed(config, query);

// After
const queryPrefix = config.enableContextualPrefix ? 'search query: ' : undefined;
queryEmbedding = await embed(config, query, queryPrefix);
```

#### 2. RRF Score Normalization

**File:** `src/search.ts:116-121`

The commit replaced the weighted linear blend (65% vector + 35% keyword) with Reciprocal Rank Fusion (RRF). RRF itself is sound, but the implementation normalized scores by dividing by the maximum RRF score, mapping everything to [0, 1].

The problem: all bonus factors downstream (recency +0.1, temporal match +0.4, entity boost +0.5, phrase boost +0.6) were calibrated for the old score distribution. After normalization, a temporal match of +0.4 was 12x the maximum RRF score (~0.033), completely dominating ranking.

**Fix:** Removed the normalization. Added a `bonusScale = 0.1` multiplier applied to all bonus factors when RRF is active, keeping them proportional to the raw RRF score range.

```typescript
const bonusScale = config.enableRRF ? 0.1 : 1.0;
entry.score += Math.max(0, 0.1 * (1 - ageDays / 30)) * bonusScale;  // Recency
entry.score += temporalBoost(c, querySignals.dates) * bonusScale;     // Temporal
// ... all other bonuses scaled similarly
```

#### 3. Reranker Default topK=5

**File:** `src/reranker.ts:49`

The cross-encoder reranker function defaulted to returning only the top 5 results regardless of the requested limit. When `enableCrossEncoderRerank` was active, this hard-capped output to 5, explaining the R@5 = R@10 symptom.

**Fix:** Changed default from 5 to 10.

#### 4. Benchmark Prefix Mismatch

**File:** `benchmarks/locomo.ts:212`

The LoCoMo benchmark bypasses the WAL and calls `storage.saveChunk()` directly. It was embedding chunks without the contextual prefix, but after fix #1, search queries used the prefix. This created the same asymmetry within the benchmark itself.

**Fix:** Added `buildContextPrefix()` call when embedding sessions in the benchmark.

### Results After Fixes

```
AFTER FIXES (no chunking):
  adversarial               R@5= 83.9%  R@10= 92.4%
  open-domain               R@5= 82.4%  R@10= 91.2%
  single-hop                R@5= 79.8%  R@10= 91.1%
  temporal                  R@5= 82.9%  R@10= 92.2%
  temporal-inference        R@5= 58.3%  R@10= 70.8%
  OVERALL                   R@5=81.3%   R@10=90.6%
```

## Sub-Session Chunking

### The Problem

With the regression fixed, temporal-inference was still the weakest category at 70.8%. Investigation revealed that long conversation sessions (1,700-5,000 chars, 15-39 turns each) produce flat embeddings that can't differentiate topics.

Concrete example: all 19 sessions in a LoCoMo conversation scored within a **0.004 range** for any query. The embedding model (MiniLM-L6-v2, 256-token context) averages over all topics in a session, producing vectors equidistant from any query. Retrieval was effectively random.

This also affects real-world usage. Storing multi-paragraph project summaries or research notes hits the same flat-embedding problem. A query like "which project uses Stripe Connect?" would match equally against all project summaries because each covers many topics in a single chunk.

### The Solution

New module `src/chunker.ts` splits long content (>500 chars) into focused 200-600 character sub-chunks at ingest time.

**Algorithm:**
1. Split on paragraph boundaries (`\n\n`)
2. If single paragraph, split on speaker turn boundaries (conversation transcripts)
3. Merge small adjacent fragments (<200 chars)
4. Split oversized fragments (>600 chars) at sentence boundaries

**Storage model:**
- **Parent chunk** stored with `consolidationLevel: -1` (sentinel value), no embedding. Participates in keyword search only.
- **Sub-chunks** stored with individual embeddings and `parentChunkId` linking to parent. Each covers 1-2 topics with a distinct embedding.

**Search pipeline changes:**
- Vector search filter excludes parent chunks (`consolidation_level != -1`)
- Keyword hits on parent chunks propagate to all sub-chunks (parent is removed from results, children inherit its keyword score)

### Configuration

Enabled by default. Toggle via environment variable:

```bash
ENGRAM_ENABLE_CHUNKING=false  # Disable chunking
```

### Chunk Size Rationale

- **Minimum 200 chars:** Avoids tiny fragments that lose context
- **Maximum 600 chars:** Keeps embeddings focused on 1-2 topics
- **Threshold 500 chars:** Content below this already produces focused embeddings
- **MiniLM-L6-v2 context window:** 256 tokens (~1024 chars). Content beyond this is averaged poorly.

### Results

```
WITH CHUNKING:
  adversarial               R@5= 89.7%  R@10= 95.1%
  open-domain               R@5= 88.8%  R@10= 94.3%
  single-hop                R@5= 78.0%  R@10= 86.9%
  temporal                  R@5= 85.0%  R@10= 91.9%
  temporal-inference        R@5= 61.5%  R@10= 74.0%
  OVERALL                   R@5=85.1%   R@10=92.0%
```

| Category | Pre-Chunking | With Chunking | Delta |
|----------|-------------|---------------|-------|
| adversarial | 92.4% | 95.1% | +2.7 |
| open-domain | 91.2% | 94.3% | +3.1 |
| single-hop | 91.1% | 86.9% | -4.2 |
| temporal | 92.2% | 91.6% | -0.6 |
| temporal-inference | 70.8% | 74.0% | +3.2 |
| **Overall R@10** | **90.6%** | **92.0%** | **+1.4** |

Single-hop regressed because some evidence spans chunk boundaries. The whole session had enough combined signal to rank in the top 10, but the specific sub-chunk containing the evidence didn't always have enough standalone signal. Context overlap between adjacent chunks was tested but hurt temporal-inference (-5.2 points) more than it helped single-hop (+0.3), so it was reverted.

### Temporal-Inference Deep Dive

Temporal-inference questions in LoCoMo are not traditional "what happened when?" queries. They're inferential reasoning: "Would Melanie go on another roadtrip soon?", "What personality traits might Melanie say Caroline has?", "Would Caroline be considered religious?"

These require:
- Synthesizing facts across multiple sessions
- Implicit fact retrieval ("Would she enjoy Vivaldi?" requires finding the session where she mentioned liking classical music)
- No explicit date anchors to trigger temporal search

At 74.0%, this remains the hardest category. Further improvement likely requires multi-hop reasoning at retrieval time, which is fundamentally different from the current single-query pipeline.

## Experiments That Failed

Not everything we tried helped. Documenting these to avoid repeating them.

### Context Overlap Between Sub-Chunks

**Hypothesis:** Single-hop regressions (-4.2 points) were caused by evidence spanning chunk boundaries. If we prepend the last 1-2 lines of the previous chunk to each subsequent chunk, boundary-spanning topics would be retrievable from either chunk.

**Implementation:** After splitting, each chunk (except the first) got the last 2 speaker turns from the previous chunk prepended.

**Result:**

| Category | Without Overlap | With Overlap | Delta |
|----------|----------------|--------------|-------|
| single-hop | 86.9% | 87.2% | +0.3 |
| temporal-inference | 74.0% | 68.8% | **-5.2** |
| Overall R@10 | 92.0% | 91.7% | -0.3 |

The overlap bloated sub-chunks with off-topic content, diluting the focused embeddings that were helping temporal-inference. The 0.3 point single-hop recovery was not worth the 5.2 point temporal-inference loss.

**Verdict:** Reverted. Clean chunk boundaries produce better embeddings than overlapping ones for this model size.

### Person-Anchored Retrieval

**Hypothesis:** Many temporal-inference misses mention a person by name ("Would Caroline want to move back?"). Boosting sessions where that person appears should pull the right sessions into the candidate pool.

**Result:** Never implemented. Analysis showed LoCoMo conversations are between the **same two people** across all ~20 sessions. Boosting by person name would boost every session equally -- zero discriminating power.

**Lesson:** Understand the data distribution before building features. A technique that sounds right for general use can be useless for a specific dataset structure.

### RRF Score Normalization

**Hypothesis:** Normalizing RRF scores to [0, 1] by dividing by the maximum score would keep bonus factors proportional.

**Result:** The opposite happened. Raw RRF scores max out at ~0.033 (for k=60). After normalization to [0, 1], additive bonus factors (+0.1 to +0.6) that were calibrated for the old weighted-blend score range became 12-18x larger than the base scores. A temporal match of +0.4 completely dominated a max RRF score of 0.033. Rankings were determined almost entirely by bonus factors, not by retrieval quality.

**Fix:** Removed normalization entirely. Scaled bonus factors down by 0.1x when RRF is active instead.

**Lesson:** When changing the scoring function, recalibrate everything downstream. Additive bonuses tuned for one score distribution will break in another.

### GPU Acceleration for Small Models

**Hypothesis:** DirectML (AMD GPU) would speed up embedding inference for the LoCoMo benchmark.

**Result:** CPU was 2x faster (58ms vs 121ms for 50 embeddings). The 23MB MiniLM model is too small for GPU transfer overhead to pay off.

**Lesson:** GPU acceleration has a minimum model size threshold. For models under ~100M parameters, CPU wins on single-item inference due to transfer costs.

## LLM Reranking Analysis

Tested `selectRelevant` (sends search results to an LLM to reorder by relevance) using Anthropic Claude Haiku via OpenRouter.

| Metric | No Rerank | With Rerank |
|--------|-----------|-------------|
| R@5 | **85.1%** | 71.5% |
| R@10 | **92.0%** | 90.6% |
| Latency | **1361ms** | 3848ms |

**Reranking is actively harmful for this pipeline.** It drops R@5 by 13.6 percentage points and triples latency with 1,986 API calls.

The hybrid search pipeline already combines vector similarity, keyword IDF, temporal signals, entity boosting, knowledge graph lookups, and spreading activation. The LLM reranker throws away all that signal and replaces it with a single-pass judgment on short text snippets stripped of context. For inferential questions ("Would Melanie go on another roadtrip?"), the LLM sees a chunk about a car accident and doesn't connect it to "roadtrip intent" -- the same problem the embeddings have, just at higher cost.

**Decision:** Do not use reranking. The retrieval pipeline outperforms it.

## GPU Acceleration Finding

Tested DirectML (DML) on AMD Radeon RX 9070 XT vs CPU for embedding inference.

| Device | 50 Embeddings | Per Embedding |
|--------|--------------|---------------|
| CPU | 58ms | 1.2ms |
| DML (GPU) | 121ms | 2.4ms |

**GPU is 2x slower than CPU for this model.** The MiniLM-L6-v2 model is 23MB with 6 layers. The CPU-to-GPU data transfer overhead dominates at this size -- the GPU never gets enough work to justify the transfer cost.

GPU acceleration would only help with larger models (e.g., `nomic-embed-text-v1.5` at 137M params, or `bge-large-en-v1.5` at 335M params).

**Decision:** Use CPU for MiniLM-L6-v2. The `ENGRAM_DEVICE` default of `cpu` is correct.

## Complete Change Log

| File | Change |
|------|--------|
| `src/search.ts` | Query prefix for embedding symmetry, RRF normalization removal, bonus scaling, parent chunk exclusion from vector search, keyword hit propagation from parents to sub-chunks |
| `src/reranker.ts` | Default topK changed from 5 to 10 |
| `src/chunker.ts` | New module -- content splitting logic with paragraph, speaker-turn, and sentence boundary strategies |
| `src/types.ts` | Added `parentChunkId` field to `MemoryChunk`, `enableChunking` config flag |
| `src/storage.ts` | Persist/read `parentChunkId`, all v2 fields added to schema seed row and `saveChunk()` |
| `src/config.ts` | `ENGRAM_ENABLE_CHUNKING` environment variable |
| `src/wal.ts` | Chunking integration in ingest path (parent + sub-chunk creation) |
| `benchmarks/locomo.ts` | Contextual prefix for session embeddings, chunking for session ingestion |

## Testing Methodology

### LoCoMo Benchmark

The [LoCoMo dataset](https://github.com/snap-research/locomo) contains 10 long conversations between pairs of people, with 1,986 QA pairs across 5 categories:

| Category | Count | Description |
|----------|-------|-------------|
| single-hop | 282 | Direct fact recall from one session |
| temporal | 321 | Questions about when things happened |
| temporal-inference | 96 | Inferential reasoning requiring synthesis across sessions |
| open-domain | 841 | General questions about conversation content |
| adversarial | 446 | Questions designed to trick retrieval (e.g., "Does the user use Rust?" when they mentioned considering it but decided against it) |

**How it works:**

1. Each conversation's sessions are ingested as memory chunks (with chunking, each session may produce multiple sub-chunks)
2. For each QA pair, the search pipeline retrieves the top K results
3. A "hit" is scored if any retrieved chunk comes from a session containing the evidence dialog IDs
4. R@K = percentage of QA pairs where the evidence was found in the top K results

**Running the benchmark:**

```bash
# Clone dataset
git clone https://github.com/snap-research/locomo.git benchmarks/data/locomo

# Full run (~5 minutes on CPU)
npm run bench:locomo

# Quick test
npm run bench:locomo -- --limit 200

# Verbose (shows individual misses)
npm run bench:locomo -- --verbose
```

### Local Benchmark

A smaller, faster test suite (`benchmarks/bench.ts`) with 18 seed memories and 15 test queries covering single-fact recall, preference recall, temporal reasoning, knowledge updates, and adversarial/distractor resistance.

```bash
npx tsx benchmarks/bench.ts --verbose
```

This uses short memories that don't trigger chunking, making it useful for testing the core search pipeline in isolation.
