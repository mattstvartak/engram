import type { SmartMemoryConfig } from './types.js';
import type { StoredChunk } from './storage.js';
import { Storage } from './storage.js';
export interface ConsolidationStats {
    linked: number;
    decayed: number;
    promoted: number;
    demoted: number;
    reactivated: number;
    dailyMoved: number;
    merged: number;
    episodicClustered: number;
    episodicSummarized: number;
}
/**
 * Background consolidation pass: links, decays, promotes, demotes, and merges memories.
 * Run this periodically (e.g., daily or at session start).
 */
export declare function consolidate(storage: Storage, config?: SmartMemoryConfig): Promise<ConsolidationStats>;
/**
 * Update FSRS stability after a recall outcome.
 * Call this from outcome.ts when a memory is recalled.
 */
export declare function computeFSRSUpdate(chunk: StoredChunk, outcome: 'helpful' | 'corrected' | 'irrelevant'): {
    stability: number;
    difficulty: number;
};
