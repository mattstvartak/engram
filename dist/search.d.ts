import type { SmartMemoryConfig, SearchResult } from './types.js';
import { Storage } from './storage.js';
/**
 * Hybrid memory search: native ANN vector search (LanceDB) + keyword
 * with IDF weighting + temporal/entity/phrase boosting + spreading activation.
 */
export declare function search(config: SmartMemoryConfig, storage: Storage, query: string, maxResults?: number, filters?: {
    domain?: string;
    topic?: string;
}): Promise<SearchResult[]>;
export declare function selectRelevant(config: SmartMemoryConfig, query: string, candidates: SearchResult[]): Promise<SearchResult[]>;
/**
 * Format recalled memories for system prompt injection.
 */
export declare function formatRecalledMemories(results: SearchResult[]): string;
