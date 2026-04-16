import { randomUUID } from 'node:crypto';
import { embed } from './llm.js';
import { buildContextPrefix } from './utils.js';
import { chunkContent } from './chunker.js';
import { extractAndPersistTriples } from './kg-extractor.js';
/**
 * Immediately persist one or more memory entries.
 * Designed to be called mid-conversation, before the agent responds.
 */
export async function ingest(config, storage, entries) {
    const chunks = [];
    for (const entry of entries) {
        if (!entry.content || entry.content.trim().length < 5)
            continue;
        const trimmedContent = entry.content.trim();
        const baseType = entry.type ?? inferType(trimmedContent);
        const baseLayer = entry.layer ?? inferLayer(trimmedContent);
        // Emotion-weighted importance: high-arousal events get stronger encoding
        // Matches amygdala research — negative high-arousal memories form faster (0.8 LR)
        // than positive ones (0.2 LR). Neutral emotions don't modify importance.
        let effectiveImportance = entry.importance ?? 0.5;
        if (entry.emotionalArousal !== undefined && entry.emotionalArousal > 0.3) {
            const valence = entry.emotionalValence ?? 0;
            // Negative-biased boost: negative emotions boost more than positive
            const emotionBoost = entry.emotionalArousal * (valence < 0 ? 0.3 : 0.15);
            effectiveImportance = Math.min(1, effectiveImportance + emotionBoost);
        }
        const baseMeta = {
            tier: 'short-term',
            type: baseType,
            cognitiveLayer: baseLayer,
            tags: entry.tags ?? [],
            domain: entry.domain ?? '',
            topic: entry.topic ?? '',
            source: entry.source ?? `wal:${Date.now()}`,
            importance: effectiveImportance,
            sentiment: entry.sentiment ?? 'neutral',
            createdAt: new Date().toISOString(),
            lastRecalledAt: null,
            recallCount: 0,
            relatedMemories: [],
            recallOutcomes: [],
        };
        // Check if content should be split into sub-chunks
        const splitResult = config.enableChunking ? chunkContent(trimmedContent) : { chunks: [trimmedContent], needsSplit: false };
        if (splitResult.needsSplit) {
            // Save parent chunk (no embedding, used for keyword search)
            const parentChunk = {
                id: randomUUID(),
                ...baseMeta,
                content: trimmedContent,
                consolidationLevel: -1, // Sentinel: parent container
            };
            await storage.saveChunk(parentChunk);
            chunks.push(parentChunk);
            // Save sub-chunks with embeddings
            for (const subContent of splitResult.chunks) {
                const subChunk = {
                    id: randomUUID(),
                    ...baseMeta,
                    content: subContent,
                    parentChunkId: parentChunk.id,
                };
                // Detect temporal anchor
                const dateMatch = subContent.match(/\b(\d{4})-(\d{2})-(\d{2})\b/) ??
                    subContent.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})[,.]?\s+(\d{4})\b/i);
                if (dateMatch) {
                    try {
                        const parsed = new Date(dateMatch[0]);
                        if (!isNaN(parsed.getTime()))
                            subChunk.temporalAnchor = parsed.getTime();
                    }
                    catch { /* skip */ }
                }
                try {
                    const prefix = buildContextPrefix(subChunk);
                    subChunk.embedding = await embed(config, subContent, prefix);
                    subChunk.embeddingVersion = 1;
                }
                catch { /* skip */ }
                await storage.saveChunk(subChunk);
                chunks.push(subChunk);
            }
        }
        else {
            // Single chunk path (original behavior)
            const chunk = {
                id: randomUUID(),
                ...baseMeta,
                content: trimmedContent,
            };
            const dateMatch = chunk.content.match(/\b(\d{4})-(\d{2})-(\d{2})\b/) ??
                chunk.content.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})[,.]?\s+(\d{4})\b/i);
            if (dateMatch) {
                try {
                    const parsed = new Date(dateMatch[0]);
                    if (!isNaN(parsed.getTime()))
                        chunk.temporalAnchor = parsed.getTime();
                }
                catch { /* skip */ }
            }
            try {
                const prefix = buildContextPrefix(chunk);
                chunk.embedding = await embed(config, chunk.content, prefix);
                chunk.embeddingVersion = 1;
            }
            catch { /* skip */ }
            await storage.saveChunk(chunk);
            chunks.push(chunk);
        }
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
        // Auto-populate knowledge graph from ingested content
        for (const chunk of chunks) {
            if (chunk.consolidationLevel === -1)
                continue; // skip parent containers
            try {
                await extractAndPersistTriples(storage, chunk.content, {
                    domain: chunk.domain,
                    topic: chunk.topic,
                    source: chunk.source,
                });
            }
            catch {
                // KG extraction is best-effort — never block ingestion
            }
        }
    }
    return chunks;
}
// ── Type/Layer inference heuristics ──────────────────────────────────
function inferType(content) {
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
function inferLayer(content) {
    const lower = content.toLowerCase();
    if (lower.includes('always') || lower.includes('never') || lower.includes('rule') || lower.includes('should'))
        return 'procedural';
    if (lower.includes('today') || lower.includes('yesterday') || lower.includes('just ') || lower.includes('session'))
        return 'episodic';
    return 'semantic';
}
//# sourceMappingURL=wal.js.map