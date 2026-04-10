---
name: memory-source
description: "Toggle which memory system the agent uses: 'engram' (exclusive Engram MCP), 'off' (no persistent memory), or 'hybrid' (Engram + native client memory). Use when the user says /memory-source or wants to switch memory backends."
user-invocable: true
metadata: {"openclaw":{"emoji":"🔌"}}
---

# Memory Source

Switch between memory backends for the current session.

## Usage

```
/memory-source <mode>
```

**Modes:**

- `engram` - Use Engram exclusively. All memory operations go through the MCP server. Native client memory (Claude Code auto-memory, etc.) is ignored. Best for users who want full control over what gets remembered.
- `off` - Disable persistent memory entirely. No memories are stored or recalled. Useful for sensitive conversations or when you want a clean slate interaction.
- `hybrid` - Use both Engram and native client memory side by side. Engram handles structured recall (search, knowledge graph, rules). Native memory handles whatever the client does by default. This is the default mode.

## Behavior

When the user invokes this command:

1. Announce the mode change clearly
2. For `engram` mode: use only `memory_search`, `memory_ingest`, `memory_format`, and other Engram MCP tools for all memory operations. Do not write to native memory systems.
3. For `off` mode: do not call any memory tools (Engram or native) for the rest of the session. Do not store anything. If the user asks you to remember something, remind them memory is off and ask if they want to switch.
4. For `hybrid` mode: use Engram for structured memory (search, ingest, rules, knowledge graph) and let native client memory do its thing alongside.

If no mode is specified, show the current mode and list the options.
