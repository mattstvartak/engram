import { randomUUID } from 'node:crypto';
import type { SmartMemoryConfig } from './types.js';
import type { StoredChunk } from './storage.js';
import { Storage } from './storage.js';

/**
 * Mem0 integration — optional cloud-based extraction provider.
 *
 * Mem0 handles extraction, deduplication, and auto-updating as a managed service.
 * Use alongside or instead of our local OpenRouter extraction.
 *
 * Requires: MEM0_API_KEY environment variable or config.mem0ApiKey
 */

// Dynamic import to avoid requiring mem0ai when not used
async function getMem0Client(apiKey: string) {
  const { MemoryClient } = await import('mem0ai');
  return new MemoryClient({ apiKey });
}

/**
 * Extract memories from a conversation using Mem0's managed extraction.
 * Mem0 automatically deduplicates and updates existing memories.
 */
export async function mem0Extract(
  config: SmartMemoryConfig,
  storage: Storage,
  messages: Array<{ role: string; content: string }>,
  conversationId: string
): Promise<StoredChunk[]> {
  const apiKey = config.mem0ApiKey || process.env.MEM0_API_KEY;
  if (!apiKey) throw new Error('MEM0_API_KEY is required for Mem0 extraction');

  const client = await getMem0Client(apiKey);
  const userId = config.mem0UserId || 'default';

  // Send conversation to Mem0 for extraction
  const mem0Messages = messages.map(m => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }));
  await client.add(mem0Messages, {
    user_id: userId,
    metadata: { source: conversationId, timestamp: new Date().toISOString() },
  });

  // Retrieve what Mem0 extracted — search with a broad query from the conversation
  const userMessages = messages.filter(m => m.role === 'user').map(m => m.content);
  const query = userMessages.slice(-3).join(' ').slice(0, 500);

  const mem0Results = await client.search(query, {
    user_id: userId,
    limit: 20,
  });

  // Sync Mem0 memories into our local LanceDB store
  const chunks: StoredChunk[] = [];
  const existing = await storage.listChunks({ excludeTiers: ['archive'] });
  const existingContents = new Set(existing.map(c => c.content.toLowerCase().trim()));

  for (const mem of mem0Results) {
    const content = mem.memory;
    if (!content || existingContents.has(content.toLowerCase().trim())) continue;

    const chunk: StoredChunk = {
      id: randomUUID(),
      tier: 'short-term',
      content,
      type: classifyMemoryType(content),
      cognitiveLayer: classifyCognitiveLayer(content),
      tags: mem.categories ?? [],
      domain: '',
      topic: '',
      source: `mem0:${conversationId}`,
      importance: (mem.score ?? 0.5) * 0.8, // Scale Mem0 relevance to our importance range
      sentiment: 'neutral',
      createdAt: String(mem.created_at ?? new Date().toISOString()),
      lastRecalledAt: null,
      recallCount: 0,
      relatedMemories: [],
      recallOutcomes: [],
    };

    await storage.saveChunk(chunk);
    chunks.push(chunk);
    existingContents.add(content.toLowerCase().trim());
  }

  // Log to daily entries
  if (chunks.length > 0) {
    const date = new Date().toISOString().split('T')[0];
    await storage.appendDailyEntry(date, {
      timestamp: new Date().toISOString(),
      conversationId: `mem0:${conversationId}`,
      summary: `Mem0 extracted ${chunks.length} memories`,
      extractedFacts: chunks.map(c => c.content),
    });
  }

  return chunks;
}

/**
 * Search Mem0 cloud memories and merge with local results.
 */
export async function mem0Search(
  config: SmartMemoryConfig,
  query: string,
  limit: number = 10
): Promise<Array<{ content: string; score: number; categories: string[] }>> {
  const apiKey = config.mem0ApiKey || process.env.MEM0_API_KEY;
  if (!apiKey) return [];

  const client = await getMem0Client(apiKey);
  const userId = config.mem0UserId || 'default';

  const results = await client.search(query, { user_id: userId, limit });

  return results.map((r: any) => ({
    content: r.memory,
    score: r.score ?? 0.5,
    categories: r.categories ?? [],
  }));
}

/**
 * Sync all Mem0 memories into local LanceDB store.
 * Useful for initial import or periodic sync.
 */
export async function mem0SyncAll(
  config: SmartMemoryConfig,
  storage: Storage
): Promise<number> {
  const apiKey = config.mem0ApiKey || process.env.MEM0_API_KEY;
  if (!apiKey) throw new Error('MEM0_API_KEY is required for Mem0 sync');

  const client = await getMem0Client(apiKey);
  const userId = config.mem0UserId || 'default';

  const allMemories = await client.getAll({ user_id: userId });
  const existing = await storage.listChunks();
  const existingContents = new Set(existing.map(c => c.content.toLowerCase().trim()));

  let synced = 0;
  for (const mem of allMemories) {
    const content = mem.memory;
    if (!content || existingContents.has(content.toLowerCase().trim())) continue;

    const chunk: StoredChunk = {
      id: randomUUID(),
      tier: 'short-term',
      content,
      type: classifyMemoryType(content),
      cognitiveLayer: classifyCognitiveLayer(content),
      tags: mem.categories ?? [],
      domain: '',
      topic: '',
      source: 'mem0:sync',
      importance: 0.5,
      sentiment: 'neutral',
      createdAt: String(mem.created_at ?? new Date().toISOString()),
      lastRecalledAt: null,
      recallCount: 0,
      relatedMemories: [],
      recallOutcomes: [],
    };

    await storage.saveChunk(chunk);
    existingContents.add(content.toLowerCase().trim());
    synced++;
  }

  return synced;
}

// ── Simple heuristic classifiers ─────────────────────────────────────
// Mem0 doesn't classify by our types, so we use keyword heuristics.

function classifyMemoryType(content: string): StoredChunk['type'] {
  const lower = content.toLowerCase();
  if (lower.includes('prefer') || lower.includes('likes') || lower.includes('loves') || lower.includes('wants'))
    return 'preference';
  if (lower.includes('decided') || lower.includes('chose') || lower.includes('will use') || lower.includes('going with'))
    return 'decision';
  if (lower.includes('correct') || lower.includes('wrong') || lower.includes('not ') || lower.includes('don\'t'))
    return 'correction';
  return 'fact';
}

function classifyCognitiveLayer(content: string): StoredChunk['cognitiveLayer'] {
  const lower = content.toLowerCase();
  if (lower.includes('always') || lower.includes('never') || lower.includes('rule') || lower.includes('prefer'))
    return 'procedural';
  if (lower.includes('yesterday') || lower.includes('today') || lower.includes('session') || lower.includes('was working'))
    return 'episodic';
  return 'semantic';
}
