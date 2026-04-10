import type { SmartMemoryConfig } from './types.js';
import type { StoredChunk } from './storage.js';
import { Storage } from './storage.js';
/**
 * Extract memories from a conversation using Mem0's managed extraction.
 * Mem0 automatically deduplicates and updates existing memories.
 */
export declare function mem0Extract(config: SmartMemoryConfig, storage: Storage, messages: Array<{
    role: string;
    content: string;
}>, conversationId: string): Promise<StoredChunk[]>;
/**
 * Search Mem0 cloud memories and merge with local results.
 */
export declare function mem0Search(config: SmartMemoryConfig, query: string, limit?: number): Promise<Array<{
    content: string;
    score: number;
    categories: string[];
}>>;
/**
 * Sync all Mem0 memories into local LanceDB store.
 * Useful for initial import or periodic sync.
 */
export declare function mem0SyncAll(config: SmartMemoryConfig, storage: Storage): Promise<number>;
