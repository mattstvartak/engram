# Roadmap

Ordered work derived from the May 2026 cross-cutting audit
(`/tmp/research/przm-memory/REPORT.md` and the four section reports under
the same directory). Each item is sized so it can become a single PR.
The "Why" line is the load-bearing rationale; the "Revisit if" line is
when this item should be deferred or skipped.

This file is forward-looking. The backward-looking record of choices
already made and deliberately deferred lives in `ARCHITECTURE_DEBT.md`;
items closed out here graduate to that ledger as resolved entries.

---

## P0 — ship this week

All P0 items are resolved — see the ledger in ARCHITECTURE_DEBT.md.

These are bugs, not features. Two of them block any credible cloud
launch; the third is undermining the product's user-facing surface today.






## P1 — ship this quarter

Items that are not bugs but are gating either performance, the
prosumer launch, or the credibility of the benchmark numbers.

### R-006 — Replace `updateChunk` N+1 in Postgres with a real partial UPDATE

**Where:** `src/storage-postgres.ts:252-263`.

**Why:** Every update is a `getChunk` + `saveChunk` (full row
read-then-write). Consolidation loops call this inside O(n²) inner
passes. At 10k chunks, a consolidation run can issue 20k+ Postgres
round-trips for what should be one UPDATE per chunk. This is the
single biggest performance cliff for any Postgres / cloud user.

**Approach:** Replace with a partial UPDATE:
```sql
UPDATE chunks
   SET metadata = metadata || $2::jsonb
 WHERE tenant_id = $1 AND id = $3
```
Add `updateChunks(updates: Array<{id, patch}>)` to the adapter
interface with a batched implementation in Postgres (unnest + CASE WHEN)
so the consolidation loops can pipeline.

**Effort:** M.

**Revisit if:** the prosumer launch decides to ship file-only
(unlikely — see R-016).

---




### R-010 — Bench a cross-encoder reranker on top-30

**Where:** `src/reranker.ts:46-72` (stub for
`Xenova/ms-marco-MiniLM-L-6-v2`).

**Why:** DEBT-009 (`ARCHITECTURE_DEBT.md`) concluded "no reranker"
based on a test of `selectRelevant()` — a listwise LLM reranker
calling Haiku with 200-character truncated docs. That's a different
cost class from cross-encoder reranking (~50ms CPU per top-30 vs
~2000ms LLM). NDCG@10 = 0.875 with R@10 = 0.988 on LongMemEval is
exactly the "found but not first" failure shape that cross-encoders
fix. Predicted lift: +5 to +10pp on LoCoMo temporal-inference (74.0%
R@10 today). Total p50 latency goes from 44ms → ~100ms.

**Approach:** Wire the stub to use `bge-reranker-v2-m3` or
`mxbai-rerank-large-v1`. Rerank top-30 after candidate scoring. Bench
against the held-out set. Reopen DEBT-009 with the cross-encoder
result.

**Effort:** M.

**Revisit if:** the bench actually shows no lift (then DEBT-009's
update should explicitly cite "cross-encoder reranking also tested,
no improvement" with the test details).

---


### R-012 — Add a tuned-BM25 baseline + 3-dataset BEIR OOD benchmark

**Where:** new files under `benchmarks/`.

**Why:** Until you know what a strong sparse baseline does on the
same data, the dense+graph+spreading apparatus's value-add is
literally unmeasured. The README's "no benchmark-specific tuning"
claim cannot be verified without OOD evidence — meanwhile at least
five LoCoMo-tuned constants exist in the pipeline.

**Approach:** Wire `bm25` (npm) or call Pyserini in the bench harness.
Run on LoCoMo R@10 and three BEIR datasets (TREC-COVID, SCIDOCS,
FiQA). Commit results to `benchmarks/results/published/`. If
tuned-BM25 hits within 5pp of przm on LoCoMo, the README's framing
needs to soften to "tuned against LoCoMo and LongMemEval; OOD
performance measured below."

**Effort:** M (annotation-free; mostly harness work).

**Revisit if:** never — this is a launch gate for any new
methodology claim, not optional.

---


## P2 — ship this year

Larger items, mostly gated on the P0/P1 work landing first.

### R-014 — Multi-tenancy + RLS + audit log bundle (DEBT-001 + 005 + 006 + 007)

Postgres RLS keyed on `current_setting('app.user_id')`. Write-time KG
edge isolation validator (DEBT-006). Audit table with trace IDs
linking back to MCP calls (DEBT-007). Approval / lifecycle workflow
for regulated verticals (DEBT-005). Pattern-share with Cortex.

**Effort:** L-XL as a bundle.

**Gates:** R-016 (prosumer tier) and any regulated-vertical deal.

---

### R-015 — Ship a Vercel AI SDK provider

`@onenomad/przm-memory-ai-sdk` targeting PR
[#11861](https://github.com/vercel/ai/pull/11861)'s `MemoryAdapter`
interface. Mem0 and Letta already ship providers — whichever memory
backend ships the popular adapter wins default-status for
Next.js / Vercel-hosted agents.

**Effort:** S (~3-5 days; the interface is small).

**Why it's not P1:** strategic, not gating. Move it earlier if Mem0
or Letta announces a Next.js integration push.

---

### R-016 — Hosted prosumer tier

$9-15/mo, single-user, multi-device sync. Cuts off Mem0's
Hobby → Starter funnel. Gated on R-014 closing for safety.

**Effort:** M as product work once the platform is ready.

---

### R-017 — HTTP MCP transport + minimal REST API

MemMachine ships both stdio and HTTP MCP; przm-memory is
stdio-only. The Cortex repo has an auth-token pattern
(`PRZM_CORTEX_MCP_AUTH_TOKEN`) — extract a shared transport layer.
Unblocks web embedding and the prosumer tier.

**Effort:** M.

---

### R-018 — Publish a memory-benchmark methodology standard

A blog post / methodology spec: "How to compare AI memory systems
honestly." Side-by-side LoCoMo R@10 vs LLM-judge with the
methodology caveats spelled out. Force competitors to disclose their
grading prompts and dropped categories. Get one independent
third-party (Vectorize.io or OSS Insight) to validate the R@K
table. This converts existing engineering work into market
position.

**Effort:** M (writing + outreach; no new code).

**Gates:** R-010, R-011, R-012 results should be in hand first so the
post can include the strongest possible numbers.

---

### R-019 — Autonomous local consolidation daemon ("Dreaming")

Background scheduler running `memory-maintain` +
adaptive-forgetting recalculation + diary insights surfacing.
Counters Anthropic's Claude Dreaming (May 6, 2026) with the
no-API-cost local version.

**Effort:** M.

---

### R-020 — Replace `translateFilter` with typed filter parameters

**Where:** `src/storage-postgres.ts:592-598`.

Regex string substitution on SQL fragments is structurally fragile.
Currently safe because the filter strings are constructed from a
small fixed set of predicates in `search.ts`, but the coupling means
any new filter that contains the substring `tier`, `domain`,
`topic`, or `cognitive_layer` in a string literal silently corrupts
the WHERE clause. Replace with explicit boolean params on
`vectorSearch` (`excludeArchived`, `excludeParentContainers`, etc.).

**Effort:** S.

---

## Backlog (low-priority cleanups)

These are real and tracked but not load-bearing. Address opportunistically
or bundle into a "tidy week."

- Ground `memory-context-pressure` server-side from the transcript the
  stop hook already reads, keeping the tool for manual override only
  (the unshipped half of R-008; the instructions trim landed
  2026-09-01).

- Replace IDF-weighted bag-of-words with a real persisted BM25 index
  (`src/search.ts`). The in-memory listChunks cache (DEBT-021,
  2026-09-01) removes the per-query full scan but the honesty issue
  and restart cost remain.
- Bounded `listChunks` and aggregate-query `getTaxonomy`
  (`src/storage-postgres.ts:243-249, 302-312`). Unbounded full table
  scans break at scale. Switch to native
  `SELECT domain, metadata->>'topic', COUNT(*) FROM chunks GROUP BY 1, 2`.
- Persistent source dedup cache or document the limitation
  (`src/wal.ts:168-198`). In-memory only; restart loses it.
- LanceDB schema migration runner (`src/storage-file.ts:77-79`).
  Ad-hoc inline try/catch. Mirror the Postgres migration pattern.
- Embedding version check on cross-chunk comparisons
  (`src/consolidator.ts`). `embeddingVersion` is stored but never
  read defensively. Fires the moment DEBT-008 closes.
- Unify `HandoffNote.name` between filesystem and adapter types
  (`src/storage-adapter.ts:37-48` vs `src/handoff.ts:21`).
- Pin the `pg` driver in regular `dependencies` with version range,
  add `@types/pg` (`package.json`, `src/storage-postgres.ts:41-44`).
- Delete the standalone `memory-budget` tool now that `memory-search`
  accepts `budgetTokens` (shipped 2026-09-01); breaking, so bundle with
  the v2 alias removal.
- Make `memory-extract.messages` a real array, not a JSON-encoded
  string (`src/server.ts:461-526`).
- Restructure `memory-ingest` duplicate response to include
  `recommendation` + `nextAction` fields
  (`src/server.ts:301-315`).
- Namespace persona coupling. `memory-search.cognitiveLoad`,
  `memory-ingest.sentiment/emotionalValence/emotionalArousal` →
  `persona: {...}` (`src/server.ts`).
- Episodic clustering determinism. Sort candidates by `createdAt`
  before greedy clustering (`src/episodic-consolidator.ts:127-151`).
- Backup tooling for LanceDB. Add a `przm-memory-backup` CLI.
- Update WAL filename / comment alignment
  (`src/wal.ts:1`, `src/index.ts:47`). Either implement the WAL or
  rename the file.

---

## Don't build

These were considered and deliberately rejected; the rationale is the
load-bearing part.

- **Source connectors** (Notion, GDrive, Slack, Gmail). Cortex's job.
  Adding them here collapses the suite story.
- **Project / people taxonomy / ontology.** Same.
- **LLM listwise reranker.** Already proven harmful on LoCoMo
  (DEBT-009). The cross-encoder rerank in R-010 is a different
  decision and should be evaluated on its own merits.
- **Speculative embedding-model abstraction** beyond the planned bge
  swap. Wait for the pull (DEBT-008). Document the dim-coupling risk
  in the meantime.
- **17k+ LLM routing.** Out of scope. Use OpenRouter; let the user
  pick.
- **"100% LongMemEval" as a headline.** MemPalace's path required
  teaching to the test; chasing the number doesn't help. NDCG@5 and
  OOD scores are the credible numbers in the saturated regime.
