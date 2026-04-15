# Engram Auto-Save Hooks

Claude Code hooks that mechanically enforce memory saves. Without these, Claude relies on instructions alone — which it often ignores when focused on coding tasks.

## What they do

### `engram_stop_hook.sh` (Stop event)
Fires after every assistant turn. Every 10 user messages, **blocks** Claude from continuing until it saves:
- Key facts and decisions via `memory_ingest`
- Entity relationships via `memory_kg_add`  
- Persona signals via `persona_signal`

### `engram_precompact_hook.sh` (PreCompact event)
Fires before context window compression. **Always blocks.** This is the safety net — context compaction is irreversible. Forces Claude to save everything important before memories are lost.

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
