# Engram Auto-Save Hooks

Claude Code hooks that keep memory saves and handoff lifelines flowing without blocking the assistant. The goal is simple: **context-full should never be a dead-end** — a fresh handoff is always on disk, and `/compact` always succeeds.

## What they do

### `engram_stop_hook.sh` (Stop event)
Fires after every assistant turn. **Non-blocking.** On each turn it:

- Parses the Claude Code transcript
- Extracts recent file reads/writes, commits, and the current task
- Overwrites a rolling `session-checkpoint.json` in the handoff dir

If the window fills so fast that `/compact` can't rescue it, the checkpoint is the lifeline. Cheap (single transcript read, no LLM), quiet (no block), and always fresh.

### `engram_precompact_hook.sh` (PreCompact event)
Fires before context compression — on both manual `/compact` and Claude Code's auto-compact. **Always approves.** The hook's job is to make sure a real handoff exists when compaction fires:

1. If Claude already called `memory_handoff_write` with `reason="compact"` within the last `ENGRAM_PRECOMPACT_WINDOW_SEC` seconds (default 300), reuse it.
2. Otherwise, auto-generate one from the transcript — same mechanical extraction the Stop hook uses (current task, edited files, commits, last assistant note) — write it to the handoff dir, and approve.

No more block-then-approve loop: `/compact` "just works" in a single step, and when Claude Code auto-compacts, the lifeline still lands.

### Why this design
- **Never block the assistant.** The old every-10-messages Stop block and the 2-phase PreCompact block-then-approve both interrupted flow. Claude's MCP instructions (SKILL.md) still push proactive `memory_ingest` / `memory_kg_add` / `memory_handoff_write` during the session — those produce the LLM-distilled memories. The hooks cover the mechanical fallback.
- **Always produce a handoff.** Either Claude wrote one (good) or the hook wrote one (also good). Either way, `memory_handoff_read` returns something meaningful in the next session.
- **Fail open.** If the extractor crashes, the hooks still approve. Stranding the user on a filesystem error would defeat the whole point.

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

## Tuning

- `ENGRAM_DATA_DIR` — where handoffs are stored. Defaults to `$HOME/.claude/engram` (matches the MCP server).
- `ENGRAM_PRECOMPACT_WINDOW_SEC` — freshness window for detecting a Claude-written compact handoff before auto-generating one. Default `300`.
