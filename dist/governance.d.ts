import type { SmartMemoryConfig } from './types.js';
import type { StoredChunk } from './storage.js';
import { Storage } from './storage.js';
/**
 * Governance middleware — advisory checks for memory integrity.
 *
 * Three subsystems:
 * 1. Contradiction detection — finds conflicting memories
 * 2. Semantic drift monitoring — detects topic shifts over time
 * 3. Memory poisoning checks — flags suspicious content patterns
 *
 * All checks are advisory — they never block ingestion.
 * LLM-enhanced when OPENROUTER_API_KEY is set, heuristic fallback otherwise.
 */
export interface ContradictionResult {
    found: boolean;
    contradictions: Array<{
        newContent: string;
        existingChunkId: string;
        existingContent: string;
        type: 'direct' | 'semantic' | 'temporal';
        confidence: number;
    }>;
}
export interface DriftReport {
    driftDetected: boolean;
    dimensions: Array<{
        dimension: string;
        cosineDrift: number;
        oldCount: number;
        newCount: number;
    }>;
    warnings: string[];
}
export interface PoisonCheckResult {
    suspicious: boolean;
    flags: Array<{
        chunkId: string;
        reason: string;
        severity: 'low' | 'medium' | 'high';
    }>;
}
export interface GovernanceReport {
    contradictions: ContradictionResult;
    drift: DriftReport;
    poisoning: PoisonCheckResult;
    checkedAt: string;
}
/**
 * Check if new content contradicts existing memories.
 * Uses vector similarity to find related memories, then heuristic
 * or LLM analysis to detect contradictions.
 */
export declare function detectContradictions(config: SmartMemoryConfig, storage: Storage, newContent: string, opts?: {
    domain?: string;
    topic?: string;
}): Promise<ContradictionResult>;
/**
 * Measure semantic drift between old and recent memories within a domain.
 * Compares embedding centroids across time windows.
 */
export declare function measureSemanticDrift(config: SmartMemoryConfig, storage: Storage, opts?: {
    domain?: string;
    windowDays?: number;
}): Promise<DriftReport>;
/**
 * Check recent memories for poisoning patterns.
 * All heuristic — no LLM needed.
 */
export declare function checkMemoryPoisoning(storage: Storage, recentChunks?: StoredChunk[]): Promise<PoisonCheckResult>;
/**
 * Run all governance checks and return a combined report.
 */
export declare function runGovernanceCheck(config: SmartMemoryConfig, storage: Storage, opts?: {
    content?: string;
    domain?: string;
}): Promise<GovernanceReport>;
