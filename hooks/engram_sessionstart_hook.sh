#!/usr/bin/env bash
# Engram session-start hook — runs once when a Claude Code session starts,
# resumes, clears, or comes back from compaction.
#
# Prints what the session should know before its first message: the latest
# handoff or crash checkpoint, the standing procedural rules, the corrections
# and preferences the user has given, and memories about the current project.
# Claude Code adds a SessionStart hook's stdout to the session context, so
# none of this depends on the agent remembering to ask.
#
# Quiet on any failure. A broken store must never block a session.

DATA_DIR="${PRZM_MEMORY_DATA_DIR:-${ENGRAM_DATA_DIR:-${SMART_MEMORY_DATA_DIR:-$HOME/.claude/przm-memory}}}"
cat >/dev/null 2>&1 || true   # drain the payload; cwd is the process cwd

CLI="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/dist/cli.js"
[ -f "$CLI" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0

PRZM_MEMORY_DATA_DIR="$DATA_DIR" node "$CLI" context --cwd "$PWD" 2>/dev/null || true
exit 0
