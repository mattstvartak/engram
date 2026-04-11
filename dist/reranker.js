let _reranker = null;
let _rerankerLoading = null;
async function getReranker() {
    if (_reranker)
        return _reranker;
    if (!_rerankerLoading) {
        _rerankerLoading = (async () => {
            const { pipeline } = await import('@huggingface/transformers');
            const modelName = process.env.ENGRAM_RERANK_MODEL ?? process.env.SMART_MEMORY_RERANK_MODEL ?? 'Xenova/ms-marco-MiniLM-L-6-v2';
            const device = process.env.ENGRAM_DEVICE ?? process.env.SMART_MEMORY_DEVICE ?? 'cpu';
            console.error(`Engram: loading reranker model ${modelName} (device: ${device})...`);
            _reranker = await pipeline('text-classification', modelName, { device });
            console.error('Engram: reranker model ready');
            return _reranker;
        })();
    }
    return _rerankerLoading;
}
/**
 * Rerank documents against a query using a cross-encoder.
 * Returns sorted results with scores, highest first.
 */
export async function rerank(query, documents, topK = 10) {
    const reranker = await getReranker();
    const results = [];
    // Score each (query, document) pair
    for (let i = 0; i < documents.length; i++) {
        try {
            // Cross-encoders take a pair and output a relevance score
            const output = await reranker(`${query} [SEP] ${documents[i].slice(0, 512)}`);
            const score = Array.isArray(output)
                ? (output[0]?.score ?? 0)
                : (output?.score ?? 0);
            results.push({ index: i, score });
        }
        catch {
            results.push({ index: i, score: 0 });
        }
    }
    // Sort by score descending, take top K
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
}
/**
 * Check if the reranker model is available (already downloaded).
 * Does not trigger download.
 */
export function isRerankerAvailable() {
    return _reranker !== null;
}
//# sourceMappingURL=reranker.js.map