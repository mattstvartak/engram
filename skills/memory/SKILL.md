---
name: memory
description: "Quick memory operations: save something, check for duplicates, view diary, or import memories from other sources. Use when the user says /memory, wants to save something specific, import from ChatGPT/Claude, or view session diary entries."
user-invocable: true
metadata: {"openclaw":{"emoji":"💾"}}
---

# Memory

Quick memory operations.

## Usage

```
/memory <subcommand> [args]
```

**Subcommands:**

- `/memory save <content>` - Save a specific memory right now
- `/memory diary [date]` - View diary entries (today if no date)
- `/memory diary write <entry>` - Write a diary entry
- `/memory import <source>` - Import memories from external sources
- `/memory rules` - View active procedural rules
- `/memory session [show|clear]` - View or clear the session scratchpad

## Behavior

### save
Call `memory_check_duplicate` first to avoid storing duplicates. If no duplicate, call `memory_ingest` with the content. Let the user know it's saved.

### diary
Call `memory_diary_read` with the date (or today). Present entries chronologically.

### diary write
Call `memory_diary_write` with the entry content.

### import
Ask the user for the file path and format:
- Claude Code JSONL (exported conversation history)
- ChatGPT JSON (exported from OpenAI)
- Plain text (one memory per line or paragraph)

Call `memory_import` with the file path and format.

### rules
Call `memory_rules`. Show active procedural rules with their confidence scores and domains. Flag any low-confidence rules that might need reinforcement or removal.

### session
Call `memory_session` with show or clear. The session scratchpad is hot RAM for the current working context. Show it formatted, or clear it at end of session.
