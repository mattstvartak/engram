import OpenAI from 'openai';
import type { SmartMemoryConfig } from './types.js';

/**
 * LLM provider for the MCP server.
 *
 * Completions: OpenRouter API (OpenAI-compatible) with OPENROUTER_API_KEY.
 *   Users can select any model available on openrouter.ai.
 *   Default model: anthropic/claude-haiku-4.5 (fast, cheap).
 *   Override with ENGRAM_MODEL env var.
 *
 * Embeddings: Local ONNX model via @huggingface/transformers.
 *   Default model: Xenova/all-MiniLM-L6-v2 (384-dim, ~23 MB, cached after first use).
 *   Override with ENGRAM_EMBEDDING_MODEL env var.
 *
 * GPU acceleration:
 *   Set ENGRAM_DEVICE=dml   for AMD/Intel/NVIDIA DirectML (Windows)
 *   Set ENGRAM_DEVICE=cuda  for NVIDIA CUDA
 *   Set ENGRAM_DEVICE=cpu   for CPU only (default)
 */

// ── LLM Completions (OpenRouter) ────────────────────────────────────

let _client: OpenAI | null = null;

function getClient(): OpenAI | null {
  if (_client) return _client;
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  _client = new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey,
  });
  return _client;
}

export function isLlmAvailable(): boolean {
  return !!process.env.OPENROUTER_API_KEY;
}

export async function llmComplete(
  _config: SmartMemoryConfig,
  systemPrompt: string,
  userMessage: string,
  opts?: { maxTokens?: number; temperature?: number }
): Promise<string> {
  const client = getClient();
  if (!client) {
    throw new Error(
      'OPENROUTER_API_KEY is required for LLM-powered features (extraction, re-ranking, procedural rules). ' +
      'Get one at https://openrouter.ai/keys -- any model provider works.'
    );
  }

  const model = process.env.ENGRAM_MODEL ?? process.env.SMART_MEMORY_MODEL ?? 'anthropic/claude-haiku-4.5';
  const response = await client.chat.completions.create({
    model,
    max_tokens: opts?.maxTokens ?? 1000,
    temperature: opts?.temperature ?? 0,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
  });

  return response.choices[0]?.message?.content ?? '';
}

// ── Local Embeddings ────────────────────────────────────────────────

let _extractor: any = null;
let _extractorLoading: Promise<any> | null = null;

function getDevice(): string {
  return process.env.ENGRAM_DEVICE ?? process.env.SMART_MEMORY_DEVICE ?? 'cpu';
}

async function getExtractor(): Promise<any> {
  if (_extractor) return _extractor;

  if (!_extractorLoading) {
    _extractorLoading = (async () => {
      const { pipeline } = await import('@huggingface/transformers');
      const modelName = process.env.ENGRAM_EMBEDDING_MODEL ?? process.env.SMART_MEMORY_EMBEDDING_MODEL ?? 'Xenova/all-MiniLM-L6-v2';
      const device = getDevice();
      console.error(`Engram: loading embedding model ${modelName} (device: ${device})...`);
      _extractor = await pipeline('feature-extraction', modelName, { device } as any);
      console.error('Engram: embedding model ready');
      return _extractor;
    })();
  }

  return _extractorLoading;
}

export async function embed(
  config: SmartMemoryConfig,
  text: string,
  contextPrefix?: string
): Promise<number[]> {
  // Hard kill-switch for callers that need to skip the ~1.5s model load
  // (e.g. CLI hooks running on every UserPromptSubmit). Throwing here lets
  // search.ts fall into its existing keyword-only fallback path.
  if (process.env.ENGRAM_SKIP_EMBED === '1') {
    throw new Error('ENGRAM_SKIP_EMBED=1');
  }
  try {
    const extractor = await getExtractor();
    // Contextual prefix improves retrieval by 35-49% (Anthropic research)
    const inputText = (config.enableContextualPrefix && contextPrefix)
      ? contextPrefix + text
      : text;
    const output = await extractor(inputText, { pooling: 'mean', normalize: true });
    const full = Array.from(output.data as Float32Array);

    // Matryoshka truncation: slice to configured dimensions and re-normalize
    if (config.embeddingDimensions > 0 && config.embeddingDimensions < full.length) {
      const truncated = full.slice(0, config.embeddingDimensions);
      const norm = Math.sqrt(truncated.reduce((s, v) => s + v * v, 0));
      if (norm > 0) return truncated.map(v => v / norm);
      return truncated;
    }

    return full;
  } catch (err) {
    console.error('Engram: embedding failed, falling back to keyword-only:', err);
    return [];
  }
}
