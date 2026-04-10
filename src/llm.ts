import Anthropic from '@anthropic-ai/sdk';
import type { SmartMemoryConfig } from './types.js';

/**
 * LLM provider for the MCP server.
 *
 * Completions: Anthropic SDK with ANTHROPIC_API_KEY.
 * Embeddings: Local ONNX model via @huggingface/transformers.
 *   Default model: Xenova/all-MiniLM-L6-v2 (384-dim, ~23 MB, cached after first use).
 *   Override with SMART_MEMORY_EMBEDDING_MODEL env var.
 *
 * GPU acceleration:
 *   Set SMART_MEMORY_DEVICE=dml   for AMD/Intel/NVIDIA DirectML (Windows)
 *   Set SMART_MEMORY_DEVICE=cuda  for NVIDIA CUDA
 *   Set SMART_MEMORY_DEVICE=cpu   for CPU only (default)
 */

// ── LLM Completions ─────────────────────────────────────────────────

let _client: Anthropic | null = null;

function getClient(): Anthropic | null {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  _client = new Anthropic({ apiKey });
  return _client;
}

export function isLlmAvailable(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
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
      'ANTHROPIC_API_KEY is required for LLM-powered features (extraction, re-ranking, procedural rules). ' +
      'Set it in your MCP server env config.'
    );
  }

  const model = process.env.SMART_MEMORY_MODEL ?? 'claude-haiku-4-5-20251001';
  const response = await client.messages.create({
    model,
    max_tokens: opts?.maxTokens ?? 1000,
    temperature: opts?.temperature ?? 0,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  const block = response.content[0];
  return block?.type === 'text' ? block.text : '';
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
