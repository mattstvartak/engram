# Engram

A memory system for AI agents that actually works. LLMs can't remember anything between conversations by default, and the existing solutions are either too simple (just dump everything in a vector DB) or too expensive (send your entire history to an API every time). Engram sits in the middle. It runs locally, doesn't need an API key for basic operation, and scores 92.0% recall on the LoCoMo benchmark. That beats every open-source memory system I've tested against.

The core idea is that memory shouldn't just be "find similar text." When someone asks "where was I working last March?" the system needs to actually reason about time, not just pattern match on the word "March." So the search pipeline combines vector similarity, keyword matching with IDF weighting, temporal inference, a knowledge graph, and spreading activation over a memory graph. Each piece handles a different kind of recall that the others miss.

## Table of Contents

- [Benchmark Results](#benchmark-results)
- [How It Works](#how-it-works)
- [Compatibility](#compatibility)
- [Installation](#installation) (Claude Code, Claude Desktop, Cursor/Windsurf/Cline, Source)
- [Configuration](#configuration)
- [Tools](#tools)
- [Slash Commands](#slash-commands)
- [Architecture](#architecture)
- [Running the Benchmarks](#running-the-benchmarks)
- [Security](#security)
- [Use Cases](#use-cases)
- [Pairs Well With: Persona MCP](#pairs-well-with-persona-mcp)
- [License](#license)

## Benchmark Results

Tested against the [LoCoMo benchmark](https://github.com/snap-research/locomo) (1,986 QA pairs across 10 long conversations). No LLM reranking, just the retrieval pipeline on its own.

```
Per-category:
  adversarial               R@5= 89.7%  R@10= 95.1%
  open-domain               R@5= 88.8%  R@10= 94.3%
  single-hop                R@5= 78.0%  R@10= 86.9%
  temporal                  R@5= 82.6%  R@10= 91.6%
  temporal-inference        R@5= 61.5%  R@10= 74.0%

  OVERALL                   R@5=85.1%   R@10=92.0%
  Embedding model           Xenova/all-MiniLM-L6-v2 (23MB, runs on CPU)
```

For details on recent benchmark optimization work including regression fixes, sub-session chunking, and reranking analysis, see [docs/benchmark-optimization.md](docs/benchmark-optimization.md).

For reference, here's how that stacks up against other memory systems on LoCoMo:

| System | Score | Metric | Requires API | Notes |
|--------|-------|--------|-------------|-------|
| **Engram** | **92.0%** | **R@10** | **No** | **Local embeddings, sub-session chunking, no rerank** |
| MemMachine v0.2 | 91.7% | LLM-judge | Yes | GPT-4.1-mini for extraction + judge |
| Backboard | 90.1% | LLM-judge | Yes | GPT-4.1 judge |
| MemPalace hybrid v5 | 88.9% | R@10 | No | Most direct comparison, same metric |
| Zep Graphiti | 85.2% | LLM-judge | Yes | Graph-based retrieval |
| Supermemory | 83.5% | R@10 | No | |
| Letta | ~83.2% | LLM-judge | Yes | |
| Zep (standard) | 75.1% | LLM-judge | Yes | |
| Mem0 | 64-67% | LLM-judge | Yes | Cloud API |
| OpenAI memory | 52.9% | LLM-judge | Yes | Built-in ChatGPT memory |

A couple things worth noting about this table. Most published scores use LLM-as-judge accuracy (did the final answer match the ground truth?), which is a different metric than R@10 retrieval recall (is the right memory in the top 10 candidates?). So not every row is a direct apples-to-apples comparison. The closest one is MemPalace at 88.9% R@10 using the same methodology and dataset.

The other thing that stands out is the API column. Most of the systems above require calls to GPT-4 or similar models for extraction, reranking, or both. Engram hits 92.0% using a 23MB local embedding model on CPU with zero API calls during retrieval. LLM reranking was tested and found to be [actively harmful](docs/benchmark-optimization.md#llm-reranking-analysis) for this pipeline.

## How It Works

### The Search Pipeline

This is where the interesting stuff happens. A query goes through nine stages before results come back.

**Stage 1: Signal Extraction.** Before any search happens, the query gets parsed for dates, entities (proper nouns), quoted phrases, and temporal language. If someone writes "What was Matt working on before he switched jobs in June?" the system extracts the date (June), the entity (Matt), and flags it as a temporal inference query because of the word "before."

**Stage 2: Vector Search.** Standard ANN search against LanceDB using cosine distance on 384-dim embeddings. This handles the "find semantically similar stuff" part. Candidates need at least 0.25 similarity to make the cut.

**Stage 3: IDF Keyword Scoring.** Rare terms in the query get weighted higher than common words. If you search for "Matt TypeScript" both terms will dominate scoring because they appear in relatively few memories. Proper nouns get an extra 1.5x boost. Results from this stage get blended with vector scores. The blend shifts toward keywords when entities are present, since names and specific nouns are better matched by exact text than by embedding similarity.

**Stage 4: Bonus Factors.** Every candidate gets adjustments for recency, recall frequency, tier, importance, and cognitive layer. Procedural memories (rules about how you want things done) get a small boost because they tend to be more immediately useful.

**Stage 5: Temporal Boost.** If the query mentions dates, memories get boosted based on whether they contain matching date strings or were created near the query date. Exact date matches in content get up to +0.4, timestamp proximity up to +0.3.

**Stage 6: Time-Window Retrieval.** This is the big one for temporal inference. When the system detects temporal signals, it pulls memories from the relevant time period into the candidate pool regardless of semantic similarity. "Where was I working in March 2024?" needs memories *from* March 2024, not just memories that happen to mention the word "March." Window size adapts to date precision. A specific day gets +/- 3 days, a month gets the full month plus buffer, a year gets the full year. If the query says "before March," the window extends 90 days earlier.

**Stage 7: Knowledge Graph Lookup.** When entities and time are both present, the system queries the knowledge graph for facts that were valid at the query time. If there's a triple like `(Matt, works-at, Acme Corp, valid 2024-01 to 2024-06)` and the query asks about Matt in March 2024, memories mentioning "Acme Corp" get boosted.

**Stage 8: Spreading Activation.** Based on [Collins & Loftus (1975)](https://en.wikipedia.org/wiki/Spreading_activation). The top 5 scoring memories activate their graph neighbors, which in turn activate their neighbors. Two hops deep, with activation decaying at each hop. Temporal edges get a 1.5x multiplier when the query involves time reasoning.

**Stage 9: Token Budget.** Results get sorted by score and trimmed to fit within a configurable token budget (default 1500 tokens). This prevents context bloat when injecting memories into prompts.

### Memory Tiers

Memories flow through four tiers with automatic promotion and demotion:

```
daily (2 days) --> short-term (14 days) --> long-term (90 days) --> archive
                        ^                                             |
                        +------ reactivation (if recalled) -----------+
```

Promotion isn't just about age. A memory moves to long-term if it's been recalled multiple times, has high importance, received "helpful" feedback, or is a procedural rule. Memories that keep getting recalled stay promoted. Memories that never get touched decay and eventually archive.

Importance decays exponentially over time, but the rates differ by cognitive layer:
- **Procedural** (rules): decays slowest (0.98/week, floor 0.15). Rules tend to stay relevant.
- **Semantic** (facts): medium decay (0.97/week, floor 0.10)
- **Episodic** (events): decays fastest (0.95/week, floor 0.05). Specific moments matter less over time.

### Cognitive Layers

Every memory gets classified into one of three layers:

- **Episodic** is for events tied to a specific moment. "User debugged a schema migration and it took most of the session."
- **Semantic** is for durable facts. "User prefers TypeScript over Python." "User's dog is named Ellie."
- **Procedural** is for behavioral rules about how the user wants things done. "Always show code before explanation." "Never use em-dashes."

The system can extract these from conversations using LLM-powered classification or, if no API key is available, a set of heuristic patterns. The heuristics catch things like "I always prefer X" (procedural), "I work at Y" (semantic fact), and "no, don't do that" (correction/procedural).

### Procedural Rules

Learned from user corrections and direct instructions. Each rule has a confidence score that shifts with evidence:

- Reinforcement (user repeats or confirms the rule): confidence +0.1
- Contradiction (user does the opposite): confidence -0.2

The asymmetry is intentional. Contradictions should weigh more because they often mean the rule was wrong. Rules that hit zero confidence get pruned.

### Knowledge Graph

Entity-relationship triples with temporal validity. Each triple records when a fact became true and optionally when it stopped being true.

```
("Matt", "works-at", "Acme Corp",  validFrom: 2024-01, validTo: 2024-06)
("Matt", "works-at", "NewCo",      validFrom: 2024-06, validTo: null)
("finch-core", "uses", "TypeScript", validFrom: 2025-01, validTo: null)
```

When a fact changes, the old triple gets invalidated (marked with an end date) and a new one gets created. The full history is preserved so the system can answer questions about the past. Adding a triple that already exists just bumps its confidence score.

### Reconsolidation

Borrowed from neuroscience. When a memory gets recalled during a relevant conversation and marked as helpful, the system can update it with new context. A memory like "User prefers TypeScript" might get refined to "User prefers TypeScript for large projects but uses Python for quick scripts" if that nuance comes up in conversation.

This only triggers if the memory hasn't been reconsolidated in the last 24 hours (to prevent over-updating) and requires an LLM API key.

### Recall Outcomes

A feedback loop that lets the system learn which memories are actually useful:

- **Helpful**: importance +0.05, triggers reconsolidation, strengthens graph edges to co-recalled memories
- **Corrected**: importance -0.10 (memory was wrong)
- **Irrelevant**: importance -0.05

If a memory gets marked irrelevant 3+ times out of the last 5 recalls, its importance drops sharply and it may get archived.

### Knowledge Graph Auto-Population

When a memory is ingested, the system heuristically extracts entity-relationship triples and adds them to the knowledge graph automatically. It detects 12 relationship types including `works-at`, `uses`, `depends-on`, `prefers`, `chose`, `located-in`, and more. This means the knowledge graph grows passively as memories accumulate, without needing explicit `memory_kg_add` calls for every fact.

### Governance Middleware

Advisory checks that flag potential issues without auto-deleting anything:

- **Contradiction detection**: Combines vector similarity, keyword heuristics, and optional LLM analysis to find memories that conflict with each other. Flags them for review.
- **Semantic drift monitoring**: Tracks how the memory store's content distribution shifts over time. Alerts if the store is drifting significantly from its historical baseline.
- **Memory poisoning checks**: Detects patterns that suggest adversarial injection — unusual embedding distributions, suspiciously high importance scores, or content that doesn't fit the user's established patterns.

### Adaptive Forgetting

Inspired by [FadeMem (Jan 2026)](https://arxiv.org/abs/2501.xxxxx). Standard FSRS decay is purely time-based, but real memory doesn't work that way. A fact that's semantically close to things you keep recalling should decay slower than an isolated fact you never revisit.

Adaptive forgetting modulates the decay rate based on semantic proximity to recently recalled memories. If a memory's nearest neighbors are getting recalled, it decays slower. If nothing nearby is ever accessed, it fades faster. This reduces storage without losing contextually relevant information.

### Duplicate Detection and Merging

New memories get checked against existing ones using Jaccard similarity on word sets (threshold 0.75). If a duplicate is found, it doesn't get stored.

During consolidation, the system also scans for near-duplicates using cosine similarity on embeddings (threshold 0.9). When found, the higher-importance memory absorbs the other's recall count and the duplicate gets deleted.

## Compatibility

Engram is an MCP (Model Context Protocol) server. It works with any client that supports the MCP standard. That includes:

- **Claude Code** (Anthropic's CLI and desktop app)
- **Claude.ai** (via MCP server configuration)
- **Cursor** (AI code editor)
- **Windsurf** (AI code editor)
- **Cline** (VS Code extension)
- **Continue** (VS Code / JetBrains extension)
- **Any MCP-compatible client** (the protocol is open and standardized)

If your tool can connect to an MCP server over stdio, Engram will work with it.

## Installation

### Claude Code

```bash
claude mcp add engram -- npx @onenomad/engram-memory
```

### Claude Desktop

Add to your Claude Desktop config file. On macOS it's at `~/Library/Application Support/Claude/claude_desktop_config.json`, on Windows at `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "engram": {
      "command": "npx",
      "args": ["@onenomad/engram-memory"]
    }
  }
}
```

Restart Claude Desktop after saving.

### Any MCP Client (Cursor, Windsurf, Cline, etc.)

Add to your client's MCP config:

```json
{
  "mcpServers": {
    "engram": {
      "command": "npx",
      "args": ["@onenomad/engram-memory"]
    }
  }
}
```

### From Source

```bash
git clone https://github.com/mattstvartak/engram.git
cd engram
npm install
npm run build
```

Then point your MCP client at `dist/server.js`:

```json
{
  "mcpServers": {
    "engram": {
      "command": "node",
      "args": ["/path/to/engram/dist/server.js"]
    }
  }
}
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENROUTER_API_KEY` | (none) | Enables LLM extraction and reranking via [OpenRouter](https://openrouter.ai). Pick any model provider you want. Without it, the system uses heuristic extraction and keyword/vector search only. |
| `MEM0_API_KEY` | (none) | Enables Mem0 cloud extraction as a second opinion |
| `ENGRAM_DATA_DIR` | `~/.claude/engram` | Where data gets stored |
| `ENGRAM_EMBEDDING_MODEL` | `Xenova/all-MiniLM-L6-v2` | HuggingFace model for embeddings |
| `ENGRAM_DEVICE` | `cpu` | Embedding device: `cpu`, `dml` (DirectML), or `cuda` |
| `ENGRAM_MODEL` | `anthropic/claude-haiku-4.5` | OpenRouter model ID for LLM features. Only used when `OPENROUTER_API_KEY` is set. Any model on [openrouter.ai](https://openrouter.ai) works. |

## Tools

The MCP server exposes 16 tools across five groups. Several earlier tools (`memory_format`, `memory_check_duplicate`, `memory_extract_rules`, `memory_taxonomy`, `memory_kg_stats`) were folded into their parent tools in 1.0.0-beta.6 — pass the relevant flag or mode to the parent instead.

### Core Memory

| Tool | What it does |
|------|-------------|
| `memory_search` | Hybrid ANN + keyword search with spreading activation. Supports a formatted output mode for prompt injection (replaces the old `memory_format`). |
| `memory_ingest` | Write-ahead log: immediately persist a memory before responding. Runs duplicate detection inline (replaces `memory_check_duplicate`). |
| `memory_extract` | Extract memories from a conversation (LLM or heuristic). Rules-only mode replaces the old `memory_extract_rules`. |
| `memory_maintain` | Run consolidation (decay, promote, link, merge). Also auto-syncs the Persona procedural bridge when both servers are running. |
| `memory_rules` | Show active procedural rules |
| `memory_outcome` | Record recall feedback (helpful/corrected/irrelevant) |
| `memory_session` | Manage session state (hot RAM scratchpad) |
| `memory_stats` | Memory statistics by tier, layer, type. Includes KG stats and domain/topic taxonomy (replaces `memory_kg_stats` and `memory_taxonomy`). |

### Knowledge Graph

| Tool | What it does |
|------|-------------|
| `memory_kg_add` | Add a subject-predicate-object triple |
| `memory_kg_query` | Query triples with optional filters |
| `memory_kg_invalidate` | Mark a fact as no longer valid |
| `memory_kg_timeline` | Get chronological history of an entity |

### Diary

| Tool | What it does |
|------|-------------|
| `memory_diary_write` | Write a session diary entry |
| `memory_diary_read` | Read diary entries by date or range |

### Governance

| Tool | What it does |
|------|-------------|
| `memory_govern` | Run governance checks: contradiction detection (vector + heuristic + LLM), semantic drift monitoring, and memory poisoning detection. All advisory — flags issues without auto-deleting. |

### Import

| Tool | What it does |
|------|-------------|
| `memory_import` | Bulk import from Claude Code JSONL, ChatGPT JSON, or plain text |

## Slash Commands

These work in any MCP-compatible client (Claude Code, Cursor, etc.). The MCP server advertises them in its instructions so the agent knows how to handle them. SKILL.md files are also included for platforms that discover skills from the filesystem.

| Command | What it does |
|---------|-------------|
| `/memory-source <engram\|off\|hybrid>` | Switch memory backend. "engram" uses Engram exclusively, "off" disables all persistent memory, "hybrid" runs Engram alongside native client memory. |
| `/recall <query>` | Search memories using the full hybrid pipeline (vector + keyword + temporal + KG + spreading activation). Results presented conversationally. |
| `/forget <what>` | Find and remove or correct specific memories. Shows matches and confirms before acting. |
| `/memory-health [maintain]` | Show memory system stats (tiers, layers, rules, KG size). With "maintain", runs the full consolidation cycle. |
| `/memory-api <key>` | Set or update the OpenRouter API key that unlocks LLM extraction, reranking, and procedural-rule learning. |
| `/knowledge <subcommand>` | Knowledge graph operations. Subcommands: `timeline <entity>`, `about <entity>`, `add <s> <p> <o>`, `correct <s> <p>`, `stats`. |
| `/memory <subcommand>` | Quick ops. Subcommands: `save <content>`, `diary [date]`, `diary write <entry>`, `import <source>`, `rules`, `session [show\|clear]`. |

### Installing Slash Commands for Claude Code

The slash commands above are advertised in Engram's MCP server instructions and work automatically in most clients. For Claude Code specifically, you can also install them as custom commands so they show up in the `/` command menu:

```bash
# From the engram directory
bash install-commands.sh

# To overwrite existing commands
bash install-commands.sh --force
```

This copies command files to `~/.claude/commands/` where Claude Code picks them up globally. After installing, type `/` in Claude Code to see them in the command list.

## Architecture

```
Conversations --> Extract --> LanceDB (vectors + metadata)
                    |                       |
              KG Auto-Populate   +----------+----------+
              (12 rel types)     |          |          |
                            Vector ANN  IDF Keywords  Time Windows
                                 |          |          |
                                 +----+-----+-----+----+
                                      |           |
                                 KG Temporal   Spreading
                                   Lookup     Activation
                                      |           |
                                      +-----+-----+
                                            |
                                      Score + Rank
                                            |
                                    Token Budget Cap
                                            |
                                   Governance Checks
                                   (advisory, async)
                                            |
                                   Format for Prompt

                         Adaptive Forgetting
                    (semantic proximity modulates decay)
                                  |
              Persona Bridge <--> Procedural Rules
              (emotion-weighted    (confidence-scored,
               importance,          learned from
               cognitive load)      corrections)
```

### Data Storage

Everything lives locally:

```
~/.claude/engram/
├── SESSION-STATE.md      # Hot RAM scratchpad
├── diary/                # Daily diary entries
│   └── YYYY-MM-DD.md
└── lance/                # LanceDB tables
    ├── chunks.lance/     # Memory chunks with embeddings
    ├── daily_logs.lance/ # Extraction logs
    ├── rules.lance/      # Procedural rules
    └── knowledge_triples.lance/
```

### Dependencies

- **LanceDB** for the embedded vector database, handles ANN search natively
- **@huggingface/transformers** for local embedding inference (Xenova/all-MiniLM-L6-v2, 384 dimensions, 23MB)
- **openai** (optional) for LLM-powered extraction and reranking via OpenRouter
- **mem0ai** (optional) for Mem0 cloud extraction
- **@modelcontextprotocol/sdk** for the MCP server protocol

## Running the Benchmarks

```bash
# Clone the LoCoMo dataset
git clone https://github.com/snap-research/locomo.git benchmarks/data/locomo

# Run the full benchmark (1,986 QA pairs, takes a few minutes)
npm run bench:locomo

# Quick test with a subset
npm run bench:locomo -- --limit 200

# With LLM reranking (requires OPENROUTER_API_KEY)
npm run bench:locomo -- --rerank

# Verbose output (shows individual misses)
npm run bench:locomo -- --verbose
```

## Security

### Network calls

This plugin contacts exactly two services:

1. **HuggingFace Hub** for a one-time model download on first run (~23MB), cached after that
2. **Mem0 API**, only when `extractionProvider` is `mem0` or `both`

If you set `OPENROUTER_API_KEY`, it contacts the OpenRouter API for LLM features (you pick the model provider). Without any API keys, everything runs fully local.

No telemetry. No analytics. No phoning home.

### Local storage

All memory data stays on disk at `~/.claude/engram/`. Nothing gets sent anywhere unless you explicitly configure an external provider.

## Use Cases

Here are some real situations where this makes a difference.

**Personal AI assistant.** The most obvious one. You talk to an AI every day and it forgets everything between sessions. Engram fixes that. It learns your preferences, remembers your projects, picks up your corrections, and builds a picture of who you are over time. Instead of re-explaining yourself every conversation, the agent just knows.

**Developer tools.** If you use Claude Code, Cursor, or any AI coding tool, the agent forgets your codebase conventions, your preferred patterns, and the decisions you've already made. Engram picks up things like "always use explicit return types" or "we deploy to Vercel, not AWS" and carries them forward. Procedural rules are built for this.

**Customer support agents.** A support bot that actually remembers a customer's history, past issues, and preferences without needing to query a CRM every time. The knowledge graph handles entity relationships ("Customer X uses Plan Y, started in March") and temporal queries let the agent reason about timelines.

**Research and note-taking.** If you use an AI to research topics over multiple sessions, Engram lets it build on previous findings instead of starting from scratch. The diary system logs what happened each session, and the search pipeline surfaces relevant prior research when you come back to a topic.

**Multi-agent systems.** Multiple agents can share the same memory store. One agent handles research, another handles coding, and they both read from and write to the same LanceDB. The MCP protocol makes this straightforward since any MCP-compatible client can connect to the server.

**Therapy / coaching bots.** Sensitive use case, but a good one. An AI that remembers what you talked about last week, tracks your goals, and notices patterns in your behavior over time. The tier lifecycle naturally keeps recent context hot while letting older sessions fade unless they stay relevant.

## Pairs Well With: Persona MCP

If Engram is the brain, [Persona](https://github.com/mattstvartak/persona) is the personality.

Engram handles *what* the agent remembers: facts, preferences, rules, timelines. Persona handles *how* the agent communicates: tone, verbosity, format preferences, and communication style. They solve different problems but work best together.

Here's why the combo matters. Engram will learn that you prefer TypeScript over Python. Persona will learn that you want short answers with code first and explanation after. Engram will store the fact that you got laid off last month. Persona will know not to bring that up casually based on the emotional context it picked up.

Persona tracks behavioral signals (corrections, approvals, frustrations, praise) and builds a communication profile that adapts over time. Engram's procedural rules overlap a little here ("never use em-dashes"), but Persona goes deeper into *how* the agent should talk to you specifically. Things like matching your energy level, knowing when to be terse vs. when to elaborate, and adjusting formality based on the topic.

When both servers are running, they coordinate through three mechanisms:

1. **Emotion-weighted memory importance.** Engram calls `persona_state` during ingestion to get the current emotional valence and arousal. High-arousal negative emotions boost memory importance by up to 30%. A frustrated correction gets remembered more strongly than a neutral fact.

2. **Cognitive-load-gated search.** When Persona detects cognitive overload, Engram's `memory_search` receives the load signal and returns only the top 3 high-importance memories instead of the full result set. Less noise when you're already overwhelmed.

3. **Procedural bridge.** Engram's learned rules (from corrections and instructions) and Persona's applied evolution proposals sync through a shared bridge file at `~/.claude/procedural-bridge.json`. Engram rules become Persona proposals. Persona's applied proposals reinforce or create Engram rules. The bridge auto-syncs during `persona_consolidate`.

You can run Engram without Persona and it works fine. But if you want an AI that actually feels like it knows you, not just what you've told it, but how you like to be talked to, run both.

## License

Licensed under the [Business Source License 1.1](LICENSE).

- **Licensor:** Matt Stvartak / OneNomad LLC
- **Licensed Work:** Engram, Copyright (c) 2026 Matt Stvartak / OneNomad LLC
- **Additional Use Grant:** You may use the Licensed Work for personal, educational, and non-commercial purposes. Production use in a commercial product or service requires a separate commercial license.
- **Change Date:** April 10, 2030
- **Change License:** Apache License, Version 2.0

Use it, fork it, learn from it, run it for yourself. You can't sell it, bundle it with paid software, host it as a service for profit, or rebrand it. On the change date it converts to Apache 2.0 and those restrictions go away.

Want to use Engram commercially before then? Reach out. I'm not trying to lock things down, I just want to know where it ends up.

For licensing inquiries: **matt@onenomad.dev**
