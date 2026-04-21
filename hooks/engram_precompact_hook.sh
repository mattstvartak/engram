#!/usr/bin/env bash
# Engram pre-compact hook — runs BEFORE context window compression.
# Blocks compaction until a structured handoff note is written.
# Compaction is irreversible; if the window fills before this runs,
# the user has to abandon the chat. The handoff note is the lifeline.

echo '{"decision":"block","reason":"⚠️ CONTEXT COMPACTION IMMINENT.\n\nBefore compaction proceeds, you MUST in this order:\n\n1. memory_handoff_write — structured \"where we left off\" snapshot. Required fields: currentTask, nextSteps, fileRefs (path:line), openQuestions, decisions, notes. Set reason=\"compact\". THIS IS THE LIFELINE if compaction fails — a fresh session can resume from it via memory_handoff_read.\n2. memory_ingest — save every unsaved fact, preference, decision, or correction from this session.\n3. memory_kg_add — record any new entity relationships.\n4. memory_diary_write — narrative summary of what happened.\n5. persona_signal — any pending user-reaction signals.\n\nDo NOT skip step 1. Memories persist; the handoff is what lets the NEXT agent pick up your work without re-explanation. Save everything, then allow compaction to proceed."}'
