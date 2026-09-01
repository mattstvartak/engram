# przm Memory Benchmarks — Methodology Reference

This is the deep technical reference for przm Memory's benchmark suite. The short version with results lives in the [README](README.md#benchmarks). This document covers what each benchmark measures, how it computes its numbers, and how to reproduce them.

## Contents

- [One-command run](#one-command-run)
- [Result files](#result-files)
- [LoCoMo](#locomo)
- [LongMemEval](#longmemeval)
- [Engram synthetic suite](#engram-synthetic-suite)
- [Ingest throughput](#ingest-throughput)
- [Query latency](#query-latency)
- [Hardware notes](#hardware-notes)
- [Known caveats](#known-caveats)

## One-command run

```bash
git clone https://github.com/OneNomad-LLC/przm-memory.git
cd przm-memory
npm install
bash benchmarks/download-datasets.sh
npm run bench:all
```

`bench:all` runs every benchmark sequentially. Each child writes a JSON file into `benchmarks/results/`, and the aggregator prints a consolidated table at the end. If a dataset is missing, that bench is skipped (not failed) so partial runs are valid.

The downloader is idempotent — re-running skips datasets already on disk. Pass `--force` to redownload, or `locomo` / `lme` to fetch only one.

## Result files

Every benchmark writes `benchmarks/results/<name>-<iso-timestamp>.json`. The schema:

```json
{
  "benchmark": "locomo",
  "version": "1.1.0",
  "commit": "abc1234",
  "config": { "embeddingModel": "...", "useRerank": false, "topK": 10 },
  "ranAt": "2026-05-12T18:31:04.221Z",
  "durationMs": 184221,
  "results": {
    "recall@5":  0.831,
    "recall@10": 0.920,
    "latencyMs": { "p50": 31, "p95": 89, "p99": 142, "avg": 38 }
  },
  "perCategory": {
    "single-hop":         { "n": 411, "recall@5": 0.78, "recall@10": 0.87, "latencyMs": { ... } },
    "temporal":           { "n": 321, "recall@5": 0.82, "recall@10": 0.91, "latencyMs": { ... } },
    "temporal-inference": { "n": 250, "recall@5": 0.61, "recall@10": 0.74, "latencyMs": { ... } },
    "open-domain":        { "n": 480, "recall@5": 0.88, "recall@10": 0.94, "latencyMs": { ... } },
    "adversarial":        { "n": 524, "recall@5": 0.89, "recall@10": 0.95, "latencyMs": { ... } }
  }
}
```

The exact key set varies per benchmark. Latency keys are omitted on benchmarks that don't track per-query latency. Metrics not computed are absent rather than reported as zero.

JSON files are gitignored. Commit the run summary in stdout or copy a JSON into a release-notes artefact if you want to pin a specific run.

## LoCoMo

**What it is.** [Snap Research's LoCoMo](https://github.com/snap-research/locomo) — 1,986 multi-hop QA pairs across 10 long synthetic conversations. Each QA pair lists evidence dialog IDs (e.g. `D5:2`) that must appear in the retrieved sessions for a hit.

**What we score.** Recall@5 and Recall@10. A retrieved session counts as a hit if it contains any of the evidence dialog IDs for the question.

**Categories.**
- `single-hop` — answer in one session
- `temporal` — answer involves dates / times
- `temporal-inference` — answer requires reasoning about time
- `open-domain` — answer requires synthesising across sessions
- `adversarial` — questions designed to trigger plausible-but-wrong matches

**How we ingest.** Each session is concatenated into a single document, embedded with [`all-MiniLM-L6-v2`](https://huggingface.co/Xenova/all-MiniLM-L6-v2), and saved with the original session timestamp (so temporal-inference queries can use the time prefix). Sessions longer than the chunker threshold are split into sub-chunks; the parent keeps the full text for keyword search.

**How we query.** Each QA pair runs through `search()` with the full hybrid pipeline — vector + keyword + temporal + spreading activation. `--rerank` enables LLM re-ranking via `selectRelevant()` (requires `OPENROUTER_API_KEY`); off by default.

**Run it.**
```bash
npm run bench:download                  # fetches the dataset
npm run bench:locomo                    # full 1,986 QA pairs
npm run bench:locomo -- --limit 200     # quick subset
npm run bench:locomo -- --rerank        # with LLM re-rank
npm run bench:locomo -- --verbose       # per-question misses
```

**Runtime.** ~3–5 minutes on an M-series Mac, ~8–12 minutes on a typical Linux laptop.

**Paper / source.** [Maharana et al., 2024 — "Evaluating Very Long-Term Conversational Memory of LLM Agents"](https://arxiv.org/abs/2402.17753).

## LongMemEval

**What it is.** [LongMemEval](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned) — 500 questions across six types (single-session-user, single-session-assistant, single-session-preference, temporal-reasoning, multi-session, knowledge-update). Each question carries on average ~53 candidate sessions, only a subset of which contain the answer.

**What we score.** Recall@5, Recall@10, NDCG@5, NDCG@10. Recall is binary per question — did we surface at least one answer session in the top K?

**How we ingest.** Each session is concatenated (`role: content` per turn), embedded, and saved with its session timestamp. One isolated storage per question (matches MemPalace's methodology).

**How we query.** Same hybrid pipeline as LoCoMo. Top-10 results map back to session IDs via the `source` field.

**Run it.**
```bash
npm run bench:download
npm run bench:longmemeval
npm run bench:longmemeval -- --limit 50
npm run bench:longmemeval -- --rerank
```

**Runtime.** ~6–10 minutes on an M-series Mac for the full 500. The dataset is ~277 MB — first download is the slow part.

**Paper.** [Wu et al., 2024 — "LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory"](https://arxiv.org/abs/2410.10813).

## Engram synthetic suite

**What it is.** A self-contained 15-question battery covering single-fact recall, preferences, temporal reasoning, knowledge updates, and adversarial / distractor resistance. No dataset download required.

**Why we have it.** Fast (~30 sec) regression signal. Catches obvious breakage in the retrieval pipeline without waiting on LoCoMo / LongMemEval to finish. Used as the pre-merge gate locally — exits non-zero when R@5 drops below 70%.

**Categories.**
- `single-fact` — basic recall (`What does the user do for work?`)
- `preference` — stable preferences (`What language does the user prefer?`)
- `temporal` — time-anchored events (`What incident happened in December 2025?`)
- `knowledge-update` — corrected / updated facts
- `adversarial` — distractor resistance (`Does the user use Rust?` → must surface "decided against")

**Negative resistance.** Some test cases declare `negativeContent` — substrings that must *not* appear in the top results. Tracked separately from recall.

**Run it.**
```bash
npm run bench                # standard
npm run bench:verbose        # per-question status
```

## Ingest throughput

**What it measures.** End-to-end ingest path — `wal.ingest()` including embedding, chunking, and storage. KG extraction is skipped (would require `OPENROUTER_API_KEY` and isn't on the critical write path). The benchmark waits for background side-effects to drain before stopping the clock, so reported throughput is "fully persisted" not "queued."

**Modes.**
- `cold` — fresh data dir, time N writes from empty
- `warm` — pre-load N chunks, then time another N (steady-state numbers)

**Output.** Chunks/sec, ms/chunk, RSS after the run.

**Run it.**
```bash
npm run bench:throughput                              # default: 10,000 chunks, both modes
npm run bench:throughput -- --chunks 5000             # smaller run
npm run bench:throughput -- --mode cold               # cold only
npm run bench:throughput -- --batch 100               # larger ingest batch
```

**What it does not measure.** Postgres backend, KG extraction, daily-entry append, real LLM-based extraction. These are documented separately. The number here is the floor — adding KG extraction with an LLM available subtracts roughly 30–50%, depending on model latency.

## Query latency

**What it measures.** Wall-clock around `search()` — the same call path that `engram-search` uses at the MCP boundary. The corpus is pre-seeded with N synthetic chunks, then M queries run sequentially. Top-K = 10 by default.

**Query buckets.** Latency varies with query length, so we report per-bucket percentiles:
- `short` — 1–3 word keyword queries
- `medium` — single-sentence natural-language questions
- `long` — multi-clause questions that stress the keyword + temporal layers

**Output.** p50 / p95 / p99 / avg per bucket and overall.

**Run it.**
```bash
npm run bench:latency                                   # default: 10,000 chunks, 1,000 queries
npm run bench:latency -- --chunks 5000 --queries 500
npm run bench:latency -- --topk 5
```

**What it does not measure.** Cold-start (first query after process boot is excluded via a warmup call). Network latency for any optional rerank step. Concurrent query throughput — this is a single-thread sequential bench.

## Hardware notes

Numbers in the README's "Our scores at HEAD" table were collected on:
- Apple M-series laptop, 32 GB RAM
- Node.js 22.x
- Local file backend (LanceDB on disk)
- No `OPENROUTER_API_KEY` set during the runs

On comparable Linux hardware (modern x86 laptop, NVMe SSD) expect throughput within ±20% and latencies within ±30%. The 23 MB embedding model loads via ONNX runtime on CPU — there's no GPU dependency.

## Known caveats

- **LoCoMo's `temporal-inference` category** is the hardest segment for the zero-API pipeline. The retriever has to compose dates that never appear verbatim in the source sessions. Reranking helps; we don't claim a fix here.
- **LongMemEval's dataset URL** is the `xiaowu0162/longmemeval-cleaned` mirror. The original `xiaowu0162/LongMemEval` repo restructured at one point — the cleaned mirror is the stable reference.
- **Ingest throughput excludes KG extraction.** That's a deliberate measurement choice (keeps the bench API-key-free) and is called out in the JSON `notes` field. Production deployments with KG extraction on should expect 30–50% lower throughput.
- **Query latency is single-threaded.** Real workloads run multiple agents concurrently; their effective per-query latency can be higher under contention. A multi-client throughput bench is open work.
- **Comparison numbers in the README** mix R@10 retrieval recall with LLM-as-judge accuracy depending on what each upstream system published. The closest apples-to-apples row is MemPalace v5 (same dataset, same metric, same retrieval-only methodology).

## Reproducing a published number

1. Note the `commit` field from the result JSON.
2. `git checkout <commit>`.
3. `npm install`.
4. `bash benchmarks/download-datasets.sh`.
5. `npm run bench:<name>`.

The `config` block in the JSON captures the embedding model, top-K, rerank flag, and any other parameters that affect the score. Match those flags exactly to reproduce.
