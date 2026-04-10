import type { SmartMemoryConfig } from './types.js';
import type { StoredChunk } from './storage.js';
import { Storage } from './storage.js';
export declare function extractFromConversation(config: SmartMemoryConfig, storage: Storage, messages: Array<{
    role: string;
    content: string;
}>, conversationId: string, opts?: {
    forceExtract?: boolean;
}): Promise<StoredChunk[]>;
export declare function reconsolidate(config: SmartMemoryConfig, storage: Storage, chunk: StoredChunk, recentMessages: Array<{
    role: string;
    content: string;
}>): Promise<void>;
