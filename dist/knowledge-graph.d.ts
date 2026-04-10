import type { KnowledgeTriple } from './types.js';
import { Storage } from './storage.js';
/**
 * Knowledge graph -- entity-relationship triples with temporal validity.
 *
 * Each triple is (subject, predicate, object) with valid_from/valid_to
 * timestamps. Facts can be invalidated when they change without losing
 * the historical record.
 *
 * Examples:
 *   ("Matt", "works-at", "Acme Corp", valid_from: 2024-01, valid_to: 2025-06)
 *   ("Matt", "works-at", "NewCo", valid_from: 2025-06, valid_to: null)
 *   ("finch-core", "uses", "TypeScript")
 *   ("smart-memory", "depends-on", "LanceDB")
 */
export declare function addTriple(storage: Storage, subject: string, predicate: string, object: string, source?: string, confidence?: number): Promise<KnowledgeTriple>;
/**
 * Add a triple and automatically invalidate conflicting ones.
 * Useful for updating facts: ("Matt", "works-at", "NewCo") invalidates
 * any existing active ("Matt", "works-at", *) triples.
 */
export declare function replaceTriple(storage: Storage, subject: string, predicate: string, object: string, source?: string, confidence?: number): Promise<KnowledgeTriple>;
/**
 * Query the knowledge graph.
 */
export declare function queryGraph(storage: Storage, opts?: {
    subject?: string;
    predicate?: string;
    object?: string;
    activeOnly?: boolean;
}): Promise<KnowledgeTriple[]>;
/**
 * Get the full timeline of an entity (as subject or object).
 */
export declare function getTimeline(storage: Storage, entity: string): Promise<KnowledgeTriple[]>;
/**
 * Invalidate a triple (mark it as no longer valid).
 */
export declare function invalidateTriple(storage: Storage, tripleId: string): Promise<void>;
/**
 * Get knowledge graph stats.
 */
export declare function getGraphStats(storage: Storage): Promise<{
    total: number;
    active: number;
    invalidated: number;
    subjects: number;
    predicates: number;
}>;
/**
 * Format active triples for context injection.
 */
export declare function formatGraphForPrompt(storage: Storage, entity?: string): Promise<string>;
