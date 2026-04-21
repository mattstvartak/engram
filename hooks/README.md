# Engram Auto-Save Hooks

Claude Code hooks that mechanically enforce memory saves. Without these, Claude relies on instructions alone — which it often ignores when focused on coding tasks.

## What they do

### `engram_stop_hook.sh` (Stop event)
Fires after every assistant turn. Every 10 user messages, **blocks** Claude from continuing until it saves:
- Key facts and decisions via `memory_ingest`
- Entity relationships via `memory_kg_add`
- Persona signals via `persona_signal`
- Context-pressure self-check via `memory_context_pressure` — if hot/critical, it must write a handoff note and `/compact` early rather than riding the window to the edge.

### `engram_precompact_hook.sh` (PreCompact event)
Fires before context window compression. **Always blocks.** This is the safety net — context compaction is irreversible, and if the window fills before this fires the user has to abandon the chat.

The hook enforces a strict sequence:
1. `memory_handoff_write` — structured "where we left off" snapshot (currentTask, nextSteps, fileRefs, openQuestions, decisions, notes). This is the lifeline if compaction fails: a fresh session picks up via `memory_handoff_read`.
2. `memory_ingest` / `memory_kg_add` / `memory_diary_write` — persist facts, relationships, and a narrative summary.
3. `persona_signal` — flush any pending user-reaction signals.

## Installation

Add to your Claude Code settings (global `~/.claude/settings.json` or per-project `.claude/settings.local.json`):

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash /path/to/engram/hooks/engram_stop_hook.sh"
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash /path/to/engram/hooks/engram_precompact_hook.sh"
          }
        ]
      }
    ]
  }
}
```

## Why this matters

MemPalace (a competing memory MCP) uses identical hooks and achieves near-100% save compliance. Without hooks, Engram's "PROACTIVE STORAGE (critical)" instruction is just a suggestion that competes with task focus — save rate drops to ~30%.
