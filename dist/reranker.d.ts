/**
 * Cross-encoder reranking using @huggingface/transformers.
 *
 * Uses a small cross-encoder model (~50MB, ONNX, CPU) to score
 * (query, document) pairs. Much more accurate than bi-encoder
 * similarity alone. Benchmarks show Hit@1 improvement from ~63% to ~83%.
 *
 * Default model: Xenova/ms-marco-MiniLM-L-6-v2
 * Override: ENGRAM_RERANK_MODEL env var
 *
 * Lazy-loaded on first call (same pattern as embedding model).
 */
export interface RerankResult {
    index: number;
    score: number;
}
/**
 * Rerank documents against a query using a cross-encoder.
 * Returns sorted results with scores, highest first.
 */
export declare function rerank(query: string, documents: string[], topK?: number): Promise<RerankResult[]>;
/**
 * Check if the reranker model is available (already downloaded).
 * Does not trigger download.
 */
export declare function isRerankerAvailable(): boolean;
