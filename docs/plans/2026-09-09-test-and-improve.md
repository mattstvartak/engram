# Test and improve, 2026-09-09

The 1.4.0 release fixed a pipeline that had been running unmeasured: outcomes were never
recorded, rules were mostly noise, and a session started from nothing. This plan measures what
the store and the new mechanisms actually do on real data, fixes what the measurements show,
and measures again.

## What is being tested

The store on this machine: 4,560 chunks across 72 domains, four months old, 98.7% written
explicitly by sessions. 209 session transcripts, 1.1 GB, of which 192 contain memory searches.

## Phase 1: measure

Four investigations, run in parallel, read only, each on its own copy of the store where it
would otherwise write. Each returns numbers from runs it did and findings with evidence.

1. **Retrieval quality.** A golden set of 25 questions, each paraphrased from a real
   correction, preference or decision so that distinctive tokens are not copied, plus five
   alien questions about topics the store does not hold. Recall at 1, 5 and 10, mean
   reciprocal rank, and for every miss what outranked the intended memory. Runs on a copy
   because a search bumps recall counts.
2. **Store integrity.** Chunks cut mid-sentence by the chunker, near-duplicate pairs from the
   same ingest, scraps under 30 characters, any leaked markup left, real corrections whose
   importance has decayed below 0.3, and domain hygiene. Counts, samples, a proposed repair
   per class. Reads the live store, writes nothing.
3. **Hook robustness.** Every bundled hook against a real transcript, a missing path, an empty
   file, a 50 MB file, a malformed payload, no stdin, and two stop hooks at once on the same
   transcript. Exit codes, stdout shape, wall time. Runs on a copy because hooks write.
4. **Outcome backfill dry run.** The grader over every transcript, dry run, aggregated: searches
   found, chunks graded, the helpful to irrelevant ratio, per project, and any transcript that
   breaks the parser. Eight graded results spot-checked by hand against the evidence that
   matched. Decides whether a real backfill is safe.

## Phase 2: improve

Decided by the measurements. Candidates already known: the chunker splitting at
abbreviations and inside backticks, the same bug the extractor had; a repair that rejoins
consecutive pieces of one ingest where the first ends mid-sentence; a `grade --all` that
backfills outcomes from history; whatever retrieval misses and hook failures turn up.

## Phase 2b: an improved startup ritual

Requested by Matt mid-run. The old ritual was three blocking MCP calls the agent had to
remember; the SessionStart hook now pushes the handoff, rules, corrections and project memories
without being asked. Write the ritual that fits the new mechanism, from what the measurements
and today's changes show actually matters at the start of a session: what to read, what to
verify before acting, what to do only when a signal appears, and what not to do. It goes in the
przm-memory section of ~/.claude/CLAUDE.md, short, because every line there is paid for on
every turn of every agent.

## Phase 3: verify

Re-run the retrieval and integrity measurements as scripts, not agents, and report before and
after. Full test suite. Commit. Publishing is a separate step.

## Success

Retrieval recall at 5 on the golden set reported honestly, with misses explained. Zero hook
failures on bad input. Outcome history backfilled if the dry run is sane, with the ratio
stated. Every number in the report comes from a run.
