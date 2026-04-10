import type { SmartMemoryConfig } from './types.js';
import { Storage } from './storage.js';
/**
 * Conversation importer -- bulk import from various chat export formats.
 *
 * Supported formats:
 *   - claude-jsonl: Claude Code JSONL exports (one JSON object per line)
 *   - chatgpt-json: ChatGPT export format (conversations[].mapping)
 *   - plain-text:   Simple "user: ... / assistant: ..." text format
 *
 * Each format is normalized into {role, content}[] then routed through
 * the extraction pipeline (LLM or heuristic depending on API availability).
 */
export type ImportFormat = 'claude-jsonl' | 'chatgpt-json' | 'plain-text';
export interface ImportResult {
    format: ImportFormat;
    conversationsFound: number;
    memoriesExtracted: number;
    errors: string[];
}
export declare function importConversation(config: SmartMemoryConfig, storage: Storage, format: ImportFormat, content: string): Promise<ImportResult>;
