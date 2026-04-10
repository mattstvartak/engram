import { randomUUID } from 'node:crypto';
import type { SmartMemoryConfig, MemoryType, CognitiveLayer } from './types.js';
import type { StoredChunk } from './storage.js';
import { Storage } from './storage.js';
import { embed } from './llm.js';

/**
 * Write-Ahead Log (WAL) — real-time memory capture during conversations.
 *
 * The WAL principle: write state BEFORE responding, not after.
 * This ensures no memory is lost if the agent crashes, compacts, or restarts.
 *
 * Use `ingest` for immediate capture of facts/decisions/preferences
 * as they happen, rather than waiting for post-conversation extraction.
 */

export interface IngestEntry {
  content: string;
  type?: MemoryType;
  layer?: CognitiveLayer;
  importance?: number;
  tags?: string[];
  source?: string;
  domain?: string;
  topic?: string;
}

/**
 * Immediately persist one or more memory entries.
 * Designed to be called mid-conversation, before the agent responds.
 */
export async function ingest(
  config: SmartMemoryConfig,
  storage: Storage,
  entries: IngestEntry[]
): Promise<StoredChunk[]> {
  const chunks: StoredChunk[] = [];

  for (const entry of entries) {
    if (!entry.content || entry.content.trim().length < 5) continue;

    const chunk: StoredChunk = {
      id: randomUUID(),
      tier: 'short-term',
      content: entry.content.trim(),
      type: entry.type ?? inferType(entry.content),
      cognitiveLayer: entry.layer ?? inferLayer(entry.content),
      tags: entry.tags ?? [],
      domain: entry.domain ?? '',
      topic: entry.topic ?? '',
      source: entry.source ?? `wal:${Date.now()}`,
      importance: entry.importance ?? 0.5,
      sentiment: 'neutral',
      createdAt: new Date().toISOString(),
      lastRecalledAt: null,
      recallCount: 0,
      relatedMemories: [],
      recallOutcomes: [],
    };

    // Generate embedding (best-effort — speed matters more for WAL)
    try {
      chunk.embedding = await embed(config, chunk.content);
    } catch {
      // Embeddings are optional for WAL
    }

    await storage.saveChunk(chunk);
    chunks.push(chunk);
  }

  // Log to daily entries
  if (chunks.length > 0) {
    const date = new Date().toISOString().split('T')[0];
    await storage.appendDailyEntry(date, {
      timestamp: new Date().toISOString(),
      conversationId: chunks[0].source,
      summary: `WAL ingest: ${chunks.length} entries`,
      extractedFacts: chunks.map(c => c.content),
    });
  }

  return chunks;
}

// ── Type/Layer inference heuristics ──────────────────────────────────

function inferType(content: string): MemoryType {
  const lower = content.toLowerCase();
  if (lower.includes('prefer') || lower.includes('like') || lower.includes('want'))
    return 'preference';
  if (lower.includes('decided') || lower.includes('going with') || lower.includes('chose') || lower.includes('use '))
    return 'decision';
  if (lower.includes('not ') || lower.includes('wrong') || lower.includes('correct') || lower.includes('instead'))
    return 'correction';
  if (lower.includes('working on') || lower.includes('currently') || lower.includes('right now'))
    return 'context';
  return 'fact';
}

function inferLayer(content: string): CognitiveLayer {
  const lower = content.toLowerCase();
  if (lower.includes('always') || lower.includes('never') || lower.includes('rule') || lower.includes('should'))
    return 'procedural';
  if (lower.includes('today') || lower.includes('yesterday') || lower.includes('just ') || lower.includes('session'))
    return 'episodic';
  return 'semantic';
}
