#!/usr/bin/env bash
# Engram auto-save hook — runs on every Stop event.
# Blocks every 10 human messages to force memory saves.
# Claude cannot proceed until it saves key context to Engram.

# Read the hook event JSON from stdin
INPUT=$(cat)

# Extract the message count from the transcript
# Count user messages (role: "user") in the conversation
# Note: uses process.stdin instead of /dev/stdin for Windows compatibility
USER_MSG_COUNT=$(echo "$INPUT" | node -e "
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => data += chunk);
  process.stdin.on('end', () => {
    try {
      const parsed = JSON.parse(data);
      const messages = parsed.messages || parsed.transcript || [];
      const userMsgs = messages.filter(m => m.role === 'user' || m.role === 'human');
      console.log(userMsgs.length);
    } catch { console.log(0); }
  });
" 2>/dev/null)

# Default to 0 if parsing failed
USER_MSG_COUNT=${USER_MSG_COUNT:-0}

# Every 10 user messages, block and require saves
if [ "$USER_MSG_COUNT" -gt 0 ] && [ $((USER_MSG_COUNT % 10)) -eq 0 ]; then
  echo '{"decision":"block","reason":"🧠 AUTO-SAVE checkpoint (every 10 messages). Before continuing:\n1. Save key facts, decisions, and user preferences via memory_ingest\n2. Record any entity relationships via memory_kg_add\n3. Log persona_signal for any user reactions you observed\n\nDo this NOW, then continue with the task."}'
else
  echo '{"decision":"approve"}'
fi
