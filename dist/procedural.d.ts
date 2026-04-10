import type { SmartMemoryConfig } from './types.js';
import { Storage } from './storage.js';
export declare function extractRules(config: SmartMemoryConfig, storage: Storage, messages: Array<{
    role: string;
    content: string;
}>, signals?: Array<{
    type: string;
    confidence: number;
}>): Promise<void>;
export declare function formatRulesForPrompt(storage: Storage): Promise<string>;
