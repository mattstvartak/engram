import { join } from 'node:path';
import { homedir } from 'node:os';
import type { SmartMemoryConfig } from './types.js';
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
export function loadConfig(overrides?: Partial<SmartMemoryConfig>): SmartMemoryConfig {
  const config: SmartMemoryConfig = {
    ...DEFAULT_CONFIG,
    dataDir: process.env.SMART_MEMORY_DATA_DIR ?? join(homedir(), '.claude', 'smart-memory'),
    ...overrides,
  };

  if (!config.mem0ApiKey) {
    config.mem0ApiKey = process.env.MEM0_API_KEY ?? '';
  }

  if (process.env.SMART_MEMORY_EXTRACTION_PROVIDER) {
    config.extractionProvider = process.env.SMART_MEMORY_EXTRACTION_PROVIDER as SmartMemoryConfig['extractionProvider'];
  }

  // v2 feature flags (env vars override defaults)
  const envBool = (key: string, fallback: boolean) => {
    const v = process.env[key];
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
    return fallback;
  };

  config.enableRRF = envBool('SMART_MEMORY_ENABLE_RRF', config.enableRRF);
  config.enableFSRS = envBool('SMART_MEMORY_ENABLE_FSRS', config.enableFSRS);
  config.enableContextualPrefix = envBool('SMART_MEMORY_ENABLE_CONTEXTUAL_PREFIX', config.enableContextualPrefix);
  config.enableBiasedReplay = envBool('SMART_MEMORY_ENABLE_BIASED_REPLAY', config.enableBiasedReplay);
  config.enableCrossEncoderRerank = envBool('SMART_MEMORY_ENABLE_CROSS_ENCODER_RERANK', config.enableCrossEncoderRerank);
  config.enableEpisodicConsolidation = envBool('SMART_MEMORY_ENABLE_EPISODIC_CONSOLIDATION', config.enableEpisodicConsolidation);

  if (process.env.SMART_MEMORY_EMBEDDING_DIM) {
    config.embeddingDimensions = parseInt(process.env.SMART_MEMORY_EMBEDDING_DIM, 10);
  }

  return config;
}
