import { join } from 'node:path';
import { homedir } from 'node:os';
import type { SmartMemoryConfig } from './types.js';
import { DEFAULT_CONFIG } from './types.js';

/**
 * Load config from environment variables.
 *
 * Data stored under ~/.claude/engram by default.
 * Override with ENGRAM_DATA_DIR (or legacy SMART_MEMORY_DATA_DIR).
 *
 * LLM calls use OPENROUTER_API_KEY (for extraction, re-ranking).
 * Any model provider on openrouter.ai works.
 * Mem0 uses MEM0_API_KEY (optional cloud extraction provider).
 */

/** Read env var with new ENGRAM_ prefix, falling back to legacy SMART_MEMORY_ prefix. */
function env(name: string, legacyName?: string): string | undefined {
  return process.env[name] ?? (legacyName ? process.env[legacyName] : undefined);
}

export function loadConfig(overrides?: Partial<SmartMemoryConfig>): SmartMemoryConfig {
  const config: SmartMemoryConfig = {
    ...DEFAULT_CONFIG,
    dataDir: env('ENGRAM_DATA_DIR', 'SMART_MEMORY_DATA_DIR') ?? join(homedir(), '.claude', 'engram'),
    ...overrides,
  };

  if (!config.mem0ApiKey) {
    config.mem0ApiKey = process.env.MEM0_API_KEY ?? '';
  }

  const extractionProvider = env('ENGRAM_EXTRACTION_PROVIDER', 'SMART_MEMORY_EXTRACTION_PROVIDER');
  if (extractionProvider) {
    config.extractionProvider = extractionProvider as SmartMemoryConfig['extractionProvider'];
  }

  // v2 feature flags (env vars override defaults)
  const envBool = (key: string, legacyKey: string, fallback: boolean) => {
    const v = env(key, legacyKey);
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
    return fallback;
  };

  config.enableRRF = envBool('ENGRAM_ENABLE_RRF', 'SMART_MEMORY_ENABLE_RRF', config.enableRRF);
  config.enableFSRS = envBool('ENGRAM_ENABLE_FSRS', 'SMART_MEMORY_ENABLE_FSRS', config.enableFSRS);
  config.enableContextualPrefix = envBool('ENGRAM_ENABLE_CONTEXTUAL_PREFIX', 'SMART_MEMORY_ENABLE_CONTEXTUAL_PREFIX', config.enableContextualPrefix);
  config.enableBiasedReplay = envBool('ENGRAM_ENABLE_BIASED_REPLAY', 'SMART_MEMORY_ENABLE_BIASED_REPLAY', config.enableBiasedReplay);
  config.enableCrossEncoderRerank = envBool('ENGRAM_ENABLE_CROSS_ENCODER_RERANK', 'SMART_MEMORY_ENABLE_CROSS_ENCODER_RERANK', config.enableCrossEncoderRerank);
  config.enableEpisodicConsolidation = envBool('ENGRAM_ENABLE_EPISODIC_CONSOLIDATION', 'SMART_MEMORY_ENABLE_EPISODIC_CONSOLIDATION', config.enableEpisodicConsolidation);
  config.enableChunking = envBool('ENGRAM_ENABLE_CHUNKING', 'SMART_MEMORY_ENABLE_CHUNKING', config.enableChunking);

  const embeddingDim = env('ENGRAM_EMBEDDING_DIM', 'SMART_MEMORY_EMBEDDING_DIM');
  if (embeddingDim) {
    config.embeddingDimensions = parseInt(embeddingDim, 10);
  }

  return config;
}
