import { Storage } from './storage.js';
/**
 * Heuristic entity-relationship extraction for auto-populating the knowledge graph.
 *
 * Runs during memory ingestion to extract (subject, predicate, object) triples
 * from natural language content. No LLM required — uses pattern matching.
 *
 * Design principles:
 * - Precision over recall: better to miss a triple than add a wrong one
 * - Confidence reflects extraction certainty (0.3-0.6 for heuristic)
 * - Deduplication handled by addTriple (bumps confidence if exists)
 * - Domain/topic from the ingestion context seed the subject when available
 */
export interface ExtractionResult {
    subject: string;
    predicate: string;
    object: string;
    confidence: number;
}
interface ExtractionContext {
    domain?: string;
    topic?: string;
    source?: string;
}
/**
 * Extract entity-relationship triples from memory content.
 * Returns raw extractions without persisting — caller decides what to save.
 */
export declare function extractTriples(content: string, context?: ExtractionContext): ExtractionResult[];
/**
 * Extract triples from content and persist them to the knowledge graph.
 * Returns the number of triples added/reinforced.
 */
export declare function extractAndPersistTriples(storage: Storage, content: string, context?: ExtractionContext): Promise<number>;
export {};
