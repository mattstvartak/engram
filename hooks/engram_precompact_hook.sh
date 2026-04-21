#!/usr/bin/env bash
# Engram pre-compact hook — runs BEFORE context window compression.
#
# Behavior:
#  - APPROVE if a fresh handoff (reason="compact", written within
#    ENGRAM_PRECOMPACT_WINDOW_SEC seconds — default 300) exists in the
#    engram data dir. This lets the SECOND /compact attempt go through
#    after Claude has done the handoff work, without further blocking.
#  - BLOCK otherwise, with the strict save-then-compact checklist.
#
# Why a freshness window: PreCompact hooks fire on every /compact attempt.
# An unconditional block creates an infinite loop — Claude writes the
# handoff, the user re-runs /compact, the hook blocks again with the same
# message. By recognizing a recent compact-handoff as "ready", we let the
# second invocation succeed naturally.
#
# Compaction is irreversible; if the window fills before the handoff
# is written, the user has to abandon the chat. The handoff note is the
# lifeline.

DATA_DIR="${ENGRAM_DATA_DIR:-${SMART_MEMORY_DATA_DIR:-$HOME/.claude/engram}}"
WINDOW_SEC="${ENGRAM_PRECOMPACT_WINDOW_SEC:-300}"

# Read stdin so Claude Code's payload doesn't break the pipe.
cat >/dev/null 2>&1 || true

FRESH=$(ENGRAM_HANDOFF_DIR="$DATA_DIR/handoffs" WINDOW_SEC="$WINDOW_SEC" node -e "
  (() => {
    try {
      const fs = require('fs');
      const path = require('path');
      const dir = process.env.ENGRAM_HANDOFF_DIR;
      const windowMs = Number(process.env.WINDOW_SEC) * 1000;
      if (!fs.existsSync(dir)) return console.log('no');
      const files = fs.readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .sort()
        .reverse();
      if (!files.length) return console.log('no');
      const latest = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
      if (latest.reason !== 'compact') return console.log('no');
      const age = Date.now() - new Date(latest.timestamp).getTime();
      if (!isFinite(age) || age < 0 || age > windowMs) return console.log('no');
      console.log('yes');
    } catch { console.log('no'); }
  })();
" 2>/dev/null)

if [ "$FRESH" = "yes" ]; then
  echo '{"decision":"approve","reason":"Fresh compact-reason handoff detected — proceeding with compaction."}'
  exit 0
fi

echo '{"decision":"block","reason":"⚠️ CONTEXT COMPACTION IMMINENT.\n\nBefore compaction proceeds, you MUST in this order:\n\n1. memory_handoff_write — structured \"where we left off\" snapshot. Required fields: currentTask, nextSteps, fileRefs (path:line), openQuestions, decisions, notes. Set reason=\"compact\". THIS IS THE LIFELINE if compaction fails — a fresh session can resume from it via memory_handoff_read.\n2. memory_ingest — save every unsaved fact, preference, decision, or correction from this session.\n3. memory_kg_add — record any new entity relationships.\n4. memory_diary_write — narrative summary of what happened.\n5. persona_signal — any pending user-reaction signals.\n\nDo NOT skip step 1. Memories persist; the handoff is what lets the NEXT agent pick up your work without re-explanation. Save everything, then RE-RUN /compact — the hook will auto-approve once it sees the fresh compact-reason handoff (within the last 5 minutes)."}'
