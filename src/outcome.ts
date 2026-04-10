import type { SmartMemoryConfig } from './types.js';
import type { StoredChunk } from './storage.js';
import { Storage } from './storage.js';
import { strengthenEdge } from './utils.js';
import { reconsolidate } from './extractor.js';

/**
 * Record the outcome of recalled memories for the feedback loop.
 * On "helpful" outcomes, triggers reconsolidation and co-recall edge strengthening.
 */
export async function recordRecallOutcome(
  config: SmartMemoryConfig,
  storage: Storage,
  chunkIds: string[],
  outcome: 'helpful' | 'corrected' | 'irrelevant',
  conversationId: string,
  recentMessages?: Array<{ role: string; content: string }>
): Promise<void> {
  const timestamp = new Date().toISOString();

  for (const id of chunkIds) {
    const chunk = await storage.getChunk(id);
    if (!chunk) continue;

    const outcomes = [...chunk.recallOutcomes, { conversationId, outcome, timestamp }];

    let importance = chunk.importance;
    if (outcome === 'helpful') importance = Math.min(1.0, importance + 0.05);
    else if (outcome === 'corrected') importance = Math.max(0.1, importance - 0.1);
    else if (outcome === 'irrelevant') importance = Math.max(0.1, importance - 0.05);

    await storage.updateChunk(id, { recallOutcomes: outcomes, importance });

    if (outcome === 'helpful') {
      for (const otherId of chunkIds) {
        if (otherId === id) continue;
        const edges = strengthenEdge(chunk.relatedMemories, otherId, 0.1);
        if (edges.some(e => e.targetId === otherId)) {
          await storage.updateChunk(id, { relatedMemories: edges });
        }
      }

      if (recentMessages && recentMessages.length > 0) {
        try {
          await reconsolidate(config, storage, chunk, recentMessages);
        } catch {
          // Reconsolidation is best-effort
        }
      }
    }
  }
}
