import type { SmartMemoryConfig } from './types.js';
import type { StoredChunk } from './storage.js';
import { Storage } from './storage.js';
export interface ConsolidationStats {
    linked: number;
    decayed: number;
    promoted: number;
    demoted: number;
    shortTermArchived: number;
    reactivated: number;
    dailyMoved: number;
    merged: number;
    episodicClustered: number;
    episodicSummarized: number;
    selfOrganized: number;
    scratchPurged: number;
}
/**
 * Background consolidation pass: links, decays, promotes, demotes, and merges memories.
 * Run this periodically (e.g., daily or at session start).
 */
export declare function consolidate(storage: Storage, config?: SmartMemoryConfig): Promise<ConsolidationStats>;
/**
 * A correction or preference the user stated explicitly does not become less true with age.
 * Measured on a live store: 314 of them had decayed to the 0.15 floor and were losing retrieval
 * to passing notes. Content and lifecycle of user-origin memories were already sacred; this
 * keeps their importance from sinking below a rule-sized floor unless recall marks them
 * irrelevant, which is a separate, evidence-driven path.
 */
export declare const INSTRUCTION_FLOOR = 0.5;
export declare function instructionFloor(chunk: StoredChunk): number;
/**
 * Update FSRS stability after a recall outcome.
 * Call this from outcome.ts when a memory is recalled.
 */
export declare function computeFSRSUpdate(chunk: StoredChunk, outcome: 'helpful' | 'corrected' | 'irrelevant'): {
    stability: number;
    difficulty: number;
};
