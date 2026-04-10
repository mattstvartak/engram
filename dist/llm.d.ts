import type { SmartMemoryConfig } from './types.js';
export declare function isLlmAvailable(): boolean;
export declare function llmComplete(_config: SmartMemoryConfig, systemPrompt: string, userMessage: string, opts?: {
    maxTokens?: number;
    temperature?: number;
}): Promise<string>;
export declare function embed(_config: SmartMemoryConfig, text: string): Promise<number[]>;
