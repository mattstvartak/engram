import OpenAI from 'openai';
import type { SmartMemoryConfig } from './types.js';

/**
 * LLM provider for the MCP server.
 *
 * Completions: OpenRouter API (OpenAI-compatible) with OPENROUTER_API_KEY.
 *   Users can select any model available on openrouter.ai.
 *   Default model: anthropic/claude-haiku-4-5-20251001 (fast, cheap).
 *   Override with SMART_MEMORY_MODEL env var.
 *
 * Embeddings: Local ONNX model via @huggingface/transformers.
 *   Default model: Xenova/all-MiniLM-L6-v2 (384-dim, ~23 MB, cached after first use).
 *   Override with SMART_MEMORY_EMBEDDING_MODEL env var.
 *
 * GPU acceleration:
 *   Set SMART_MEMORY_DEVICE=dml   for AMD/Intel/NVIDIA DirectML (Windows)
 *   Set SMART_MEMORY_DEVICE=cuda  for NVIDIA CUDA
 *   Set SMART_MEMORY_DEVICE=cpu   for CPU only (default)
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

  const model = process.env.SMART_MEMORY_MODEL ?? 'anthropic/claude-haiku-4-5-20251001';
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
  return process.env.SMART_MEMORY_DEVICE ?? 'cpu';
}

async function getExtractor(): Promise<any> {
  if (_extractor) return _extractor;

  if (!_extractorLoading) {
    _extractorLoading = (async () => {
      const { pipeline } = await import('@huggingface/transformers');
      const modelName = process.env.SMART_MEMORY_EMBEDDING_MODEL ?? 'Xenova/all-MiniLM-L6-v2';
      const device = getDevice();
      console.error(`Smart Memory: loading embedding model ${modelName} (device: ${device})...`);
      _extractor = await pipeline('feature-extraction', modelName, { device } as any);
      console.error('Smart Memory: embedding model ready');
      return _extractor;
    })();
  }

  return _extractorLoading;
}

export async function embed(
  _config: SmartMemoryConfig,
  text: string
): Promise<number[]> {
  try {
    const extractor = await getExtractor();
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data as Float32Array);
  } catch (err) {
    console.error('Smart Memory: embedding failed, falling back to keyword-only:', err);
    return [];
  }
}
