import type { StoredChunk } from './storage.js';
import type { MemoryEdge } from './types.js';
export declare function estimateTokens(text: string): number;
export declare function cosineSimilarity(a: number[], b: number[]): number;
export declare function isDuplicate(content: string, existing: StoredChunk[]): boolean;
export declare function getEdgeTargetIds(edges: MemoryEdge[]): string[];
export declare function addEdge(edges: MemoryEdge[], targetId: string, relationship: MemoryEdge['relationship'], weight?: number): MemoryEdge[];
export declare function strengthenEdge(edges: MemoryEdge[], targetId: string, delta: number): MemoryEdge[];
export declare function buildContextPrefix(chunk: {
    type?: string;
    cognitiveLayer?: string;
    domain?: string;
    topic?: string;
    tags?: string[];
    createdAt?: string;
}): string;
