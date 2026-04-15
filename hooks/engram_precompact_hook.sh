#!/usr/bin/env bash
# Engram pre-compact hook — runs BEFORE context window compression.
# ALWAYS blocks to ensure memories are saved before context is lost.
# This is the critical safety net — context compaction is irreversible.

echo '{"decision":"block","reason":"⚠️ CONTEXT COMPACTION IMMINENT — memories will be lost if not saved NOW.\n\nBefore compaction, you MUST:\n1. memory_ingest: Save ALL key facts, decisions, preferences, and project context from this session\n2. memory_kg_add: Record any new entity relationships discovered\n3. memory_diary_write: Summarize what was accomplished, decisions made, and open threads\n4. persona_signal: Record any pending user behavioral signals\n\nThis is NOT optional. Save everything important, then allow compaction to proceed."}'
