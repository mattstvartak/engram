---
name: smart-memory
description: Intelligent memory manager with LLM-powered extraction, hybrid ANN vector+keyword search, tier lifecycle, spreading activation, procedural rules, WAL capture, and session-state hot RAM. Use when the user asks about memory, preferences, or past conversations.
homepage: https://github.com/mattstvartak/openclaw-smart-memory-plugin
metadata: {"openclaw":{"emoji":"🧠","requires":{"bins":["node"]}},"version":"1.0.2","categories":["memory","intelligence","personalization"]}
---

# Smart Memory Manager

An intelligent memory system that automatically extracts, stores, searches, and maintains memories from conversations. Inspired by cognitive science research on memory consolidation, spreading activation, and reconsolidation.

## How It Works

### Memory Extraction
After conversations, pipe the messages through the `extract` command. An LLM classifies each extracted memory by:
- **Type**: fact, preference, decision, context, correction
- **Cognitive Layer**: episodic (events), semantic (enduring facts), procedural (rules)
- **Importance**: 0.0–1.0 scale (conservative — most memories are 0.3–0.6)
- **Sentiment**: frustrated, curious, satisfied, neutral, excited, confused

### Memory Search (Hybrid)
Search combines multiple signals:
1. **Vector similarity** — embedding-based semantic matching
2. **Keyword matching** — word-boundary regex (avoids "test" matching "contest")
3. **Recency bonus** — newer memories score higher
4. **Frequency bonus** — frequently recalled memories score higher
5. **Importance bonus** — high-importance memories get a boost
6. **Spreading activation** — walks the memory graph to find related memories not directly matching the query (Collins & Loftus 1975, Synapse paper 2026)

### Tier Lifecycle
- **Daily** (2 days) → auto-moves to short-term if importance ≥ 0.3
- **Short-term** (14 days) → promotes to long-term if recalled frequently or high importance
- **Long-term** (90 days) → demotes to archive if stale and low importance
- **Archive** → reactivates if recalled again within 7 days

### Procedural Rules
Learns behavioral rules from user corrections and explicit instructions. Rules have:
- **Confidence** (0.0–1.0): reinforced by +0.1, contradicted by -0.2
- **Domain**: code, communication, workflow, preference, general
- Dead rules (confidence = 0) are pruned automatically

### Recall Outcomes
When you mark recalled memories as helpful/corrected/irrelevant:
- **Helpful**: importance +0.05, triggers reconsolidation (re-encodes memory through current context)
- **Corrected**: importance -0.10
- **Irrelevant**: importance -0.05
- Co-recalled helpful memories strengthen their graph edges

## Commands

### Extract memories from a conversation
```bash
# From a JSON file of [{role: "user", content: "..."}, ...]
node dist/cli.js extract conversation.json session-123

# From stdin
cat conversation.json | node dist/cli.js extract
```

### Search memories
```bash
node dist/cli.js search "what programming languages does the user prefer"
```

### Format for system prompt injection
```bash
node dist/cli.js format "current user question or topic"
```

Returns structured text grouped by cognitive layer:
```
--- RECALLED MEMORIES ---
## How this user works
- Always show code before explanation
- Never use em-dashes in writing

## Known facts
- [preference] User prefers TypeScript over Python
- [fact] User is building a SaaS product

## Recent context
- User was debugging OAuth integration yesterday
```

### Run maintenance (consolidation)
```bash
node dist/cli.js maintain
```

### View/extract procedural rules
```bash
node dist/cli.js rules              # Show active rules
node dist/cli.js rules extract conv.json  # Extract rules from conversation
```

### Record recall outcome
```bash
node dist/cli.js outcome helpful chunk-id-1 chunk-id-2
```

### View statistics
```bash
node dist/cli.js stats
```

## WAL (Write-Ahead Log)

Real-time memory capture during conversations. The WAL principle: **write state BEFORE responding, not after**. This ensures no memory is lost if the agent crashes, compacts, or restarts.

```bash
# Immediately persist a memory mid-conversation
node dist/cli.js ingest "User prefers Tailwind over vanilla CSS" --type preference --importance 0.8

# With tags
node dist/cli.js ingest "Decided to use React for frontend" --type decision --tags react,frontend

# Batch ingest from stdin (JSON array of entries)
echo '[{"content":"User is a data scientist","type":"fact","importance":0.7}]' | node dist/cli.js ingest
```

## Mem0 Cloud Integration

Optional managed extraction via [Mem0](https://mem0.ai). Mem0 handles extraction, deduplication, and auto-updating as a service. Use alongside or instead of local OpenRouter extraction.

```bash
# Extract via Mem0 cloud and sync to local LanceDB
node dist/cli.js mem0 extract conversation.json

# Search Mem0 cloud directly
node dist/cli.js mem0 search "CSS preferences"

# Sync all Mem0 memories to local store
node dist/cli.js mem0 sync
```

Set `extractionProvider` to control which provider is used during `extract`:
- `local` — OpenRouter LLM extraction (default)
- `mem0` — Mem0 cloud only
- `both` — Run both providers and merge results

## Session State (Hot RAM)

A fast-write scratchpad for active session state that survives compaction. Persisted as `SESSION-STATE.md` for direct injection into OpenClaw's workspace bootstrap.

```bash
node dist/cli.js session task "Building the auth module"
node dist/cli.js session context "Using JWT with refresh tokens"
node dist/cli.js session decision "Chose Postgres over MongoDB"
node dist/cli.js session action "Write migration scripts"
node dist/cli.js session show     # View current state
node dist/cli.js session clear    # Reset at end of session
```

The SESSION-STATE.md file is plain markdown — inject it into your system prompt for instant context recovery.

## Configuration

Configure in `openclaw.json` under `plugins.entries.openclaw-smart-memory-plugin.config`. No API keys required — the plugin uses your existing OpenClaw model provider.

Optional: set `MEM0_API_KEY` environment variable if using Mem0 cloud extraction.

## Integration with OpenClaw

### As a post-conversation hook
After each session, pipe the conversation history through extraction:
```bash
node ~/.openclaw/workspace/skills/smart-memory/dist/cli.js extract session-export.json
```

### WAL during conversations
Before responding to important user statements, call `ingest` to persist immediately:
```bash
node ~/.openclaw/workspace/skills/smart-memory/dist/cli.js ingest "User prefers dark mode" --type preference
```

### In system prompt assembly
Use `format` to get recalled memories for the current query, then inject into the system prompt alongside SOUL.md and other workspace files.

### Session state recovery
Inject `SESSION-STATE.md` into the bootstrap to survive compaction and restarts.

### Periodic maintenance
Run `maintain` daily (via cron or OpenClaw's cron skill) to consolidate memories:
```bash
node ~/.openclaw/workspace/skills/smart-memory/dist/cli.js maintain
```
