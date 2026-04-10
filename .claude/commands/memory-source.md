Switch memory backend to: $ARGUMENTS

Modes:
- `engram` - Use Engram exclusively. All memory operations go through the MCP server. Native client memory is ignored.
- `off` - Disable persistent memory entirely. No memories are stored or recalled.
- `hybrid` - Use both Engram and native client memory side by side. This is the default.

Announce the mode change clearly. If no mode is specified, show the current mode and list the options.

For `engram` mode: use only Engram MCP tools for all memory operations.
For `off` mode: do not call any memory tools for the rest of the session.
For `hybrid` mode: use Engram for structured memory and let native client memory do its thing alongside.
