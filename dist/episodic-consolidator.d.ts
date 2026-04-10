import type { SmartMemoryConfig } from './types.js';
import { Storage } from './storage.js';
/**
 * Episodic-to-semantic consolidation (Improvement 8).
 *
 * Modeled after Complementary Learning Systems theory (McClelland 1995).
 * The hippocampus stores episodic memories fast, then consolidation
 * extracts shared principles into semantic memory.
 *
 * Three levels:
 * - L0 (raw): individual memories, current daily/short-term tier
 * - L1 (episode summaries): clusters of related L0 memories summarized
 * - L2 (principles): extracted rules/facts, minimal decay
 *
 * Consolidation is replay-driven, not time-driven. When multiple
 * episodic memories share overlapping entities and themes, that's
 * the consolidation signal.
 */
export interface EpisodicConsolidationStats {
    clustered: number;
    summarized: number;
    promoted: number;
}
/**
 * Run episodic-to-semantic consolidation.
 * Clusters related episodic memories older than 7 days,
 * generates summaries, and stores them as L1 semantic chunks.
 */
export declare function consolidateEpisodic(config: SmartMemoryConfig, storage: Storage): Promise<EpisodicConsolidationStats>;
