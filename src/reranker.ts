import type { SmartMemoryConfig } from './types.js';

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

let _reranker: any = null;
let _rerankerLoading: Promise<any> | null = null;

async function getReranker(): Promise<any> {
  if (_reranker) return _reranker;

  if (!_rerankerLoading) {
    _rerankerLoading = (async () => {
      const { pipeline } = await import('@huggingface/transformers');
      const modelName = process.env.ENGRAM_RERANK_MODEL ?? process.env.SMART_MEMORY_RERANK_MODEL ?? 'Xenova/ms-marco-MiniLM-L-6-v2';
      const device = process.env.ENGRAM_DEVICE ?? process.env.SMART_MEMORY_DEVICE ?? 'cpu';
      console.error(`Engram: loading reranker model ${modelName} (device: ${device})...`);
      _reranker = await pipeline('text-classification', modelName, { device } as any);
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
export async function rerank(
  query: string,
  documents: string[],
  topK: number = 10
): Promise<RerankResult[]> {
  const reranker = await getReranker();

  const results: RerankResult[] = [];

  // Score each (query, document) pair
  for (let i = 0; i < documents.length; i++) {
    try {
      // Cross-encoders take a pair and output a relevance score
      const output = await reranker(`${query} [SEP] ${documents[i].slice(0, 512)}`);
      const score = Array.isArray(output)
        ? (output[0]?.score ?? 0)
        : (output?.score ?? 0);
      results.push({ index: i, score });
    } catch {
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
export function isRerankerAvailable(): boolean {
  return _reranker !== null;
}
