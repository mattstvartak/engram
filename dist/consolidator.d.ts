import { Storage } from './storage.js';
export interface ConsolidationStats {
    linked: number;
    decayed: number;
    promoted: number;
    demoted: number;
    reactivated: number;
    dailyMoved: number;
    merged: number;
}
/**
 * Background consolidation pass: links, decays, promotes, demotes, and merges memories.
 * Run this periodically (e.g., daily or at session start).
 */
export declare function consolidate(storage: Storage): Promise<ConsolidationStats>;
