import type { SmartMemoryConfig } from './types.js';
import { Storage } from './storage.js';
/**
 * Record the outcome of recalled memories for the feedback loop.
 * On "helpful" outcomes, triggers reconsolidation and co-recall edge strengthening.
 */
export declare function recordRecallOutcome(config: SmartMemoryConfig, storage: Storage, chunkIds: string[], outcome: 'helpful' | 'corrected' | 'irrelevant', conversationId: string, recentMessages?: Array<{
    role: string;
    content: string;
}>): Promise<void>;
