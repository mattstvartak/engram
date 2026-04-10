import { join } from 'node:path';
import { homedir } from 'node:os';
import { DEFAULT_CONFIG } from './types.js';
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
export function loadConfig(overrides) {
    const config = {
        ...DEFAULT_CONFIG,
        dataDir: process.env.SMART_MEMORY_DATA_DIR ?? join(homedir(), '.claude', 'smart-memory'),
        ...overrides,
    };
    if (!config.mem0ApiKey) {
        config.mem0ApiKey = process.env.MEM0_API_KEY ?? '';
    }
    if (process.env.SMART_MEMORY_EXTRACTION_PROVIDER) {
        config.extractionProvider = process.env.SMART_MEMORY_EXTRACTION_PROVIDER;
    }
    return config;
}
//# sourceMappingURL=config.js.map