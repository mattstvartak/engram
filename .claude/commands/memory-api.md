Set the OpenRouter API key for Engram's LLM features. $ARGUMENTS

1. Take the provided API key
2. Find the Engram MCP server's configuration
3. Update the `OPENROUTER_API_KEY` environment variable
4. Confirm the key was set (show only the last 4 characters for security)
5. If no key is provided, show current status (key set or not)

Notes:
- Get a key at https://openrouter.ai/keys
- Without a key, Engram uses heuristic extraction and keyword/vector search only
- With a key, you get LLM-powered memory extraction, reranking, procedural rule detection, and reconsolidation
- Default model is anthropic/claude-haiku-4.5, override with ENGRAM_MODEL env var
