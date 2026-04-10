import type { SmartMemoryConfig, MemoryType, CognitiveLayer } from './types.js';
import type { StoredChunk } from './storage.js';
import { Storage } from './storage.js';
/**
 * Write-Ahead Log (WAL) — real-time memory capture during conversations.
 *
 * The WAL principle: write state BEFORE responding, not after.
 * This ensures no memory is lost if the agent crashes, compacts, or restarts.
 *
 * Use `ingest` for immediate capture of facts/decisions/preferences
 * as they happen, rather than waiting for post-conversation extraction.
 */
export interface IngestEntry {
    content: string;
    type?: MemoryType;
    layer?: CognitiveLayer;
    importance?: number;
    tags?: string[];
    source?: string;
    domain?: string;
    topic?: string;
}
/**
 * Immediately persist one or more memory entries.
 * Designed to be called mid-conversation, before the agent responds.
 */
export declare function ingest(config: SmartMemoryConfig, storage: Storage, entries: IngestEntry[]): Promise<StoredChunk[]>;
