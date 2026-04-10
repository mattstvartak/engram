import type { SmartMemoryConfig } from './types.js';
/**
 * Load config from environment variables.
 *
 * Data stored under ~/.claude/smart-memory by default.
 * Override with SMART_MEMORY_DATA_DIR.
 *
 * LLM calls use OPENROUTER_API_KEY (for extraction, re-ranking).
 * Any model provider on openrouter.ai works.
 * Mem0 uses MEM0_API_KEY (optional cloud extraction provider).
 */
export declare function loadConfig(overrides?: Partial<SmartMemoryConfig>): SmartMemoryConfig;
