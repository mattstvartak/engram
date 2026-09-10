import type { SmartMemoryConfig, MemoryType, CognitiveLayer, Sentiment, MemoryOrigin, MemoryTier } from './types.js';
import type { StoredChunk } from './storage.js';
import { Storage } from './storage.js';
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
    sentiment?: Sentiment;
    emotionalValence?: number;
    emotionalArousal?: number;
    origin?: MemoryOrigin;
    tier?: MemoryTier;
    /**
     * ISO 8601 timestamp override. Default: ingest time (Date.now()).
     *
     * Critical when the content represents an event that originally
     * happened at a different time — meeting notes from yesterday,
     * dated documents, imported chat history, benchmark fixtures.
     *
     * The createdAt timestamp flows into `buildContextPrefix()` which
     * is included in the embedded text. The retrieval pipeline uses
     * this as a temporal signal — both via similarity match against
     * the prefix in queries, and via downstream temporal-boost logic
     * in `search.ts`.
     *
     * Without an override, every ingested memory shares the ingest-
     * time prefix (which is the same for everything ingested in the
     * same hour), losing all temporal differentiation.
     */
    createdAt?: string;
    /**
     * When true, skip the per-chunk KG triple extraction. The standalone
     * locomo bench bypasses this (calls saveChunk directly, never enters
     * wal.ts), which is why its wall-clock is ~50× faster than przm's
     * MCP-boundary bench on the same dataset.
     *
     * Real users keep KG extraction (it powers engram-dossier,
     * engram-kg-query, graph rerank). Benchmark harnesses comparing
     * apples-to-apples vs the standalone bench should pass this flag
     * so they're measuring the same code path.
     */
    skipKgExtraction?: boolean;
    /**
     * When true, skip the post-batch appendDailyEntry write. Same
     * rationale as skipKgExtraction — the standalone bench doesn't
     * touch the daily-entries store; bench harnesses matching it
     * should skip the write to compare on equal footing.
     */
    skipDailyEntry?: boolean;
    /**
     * When false, KG extraction + daily-entry append run in the
     * BACKGROUND after ingest() returns. The caller gets its chunks
     * back as soon as the saveChunk loop finishes; the side effects
     * complete on their own pace.
     *
     * Default true (backwards compatible — caller awaits everything).
     * Production callers where the agent doesn't immediately query
     * the just-written content (chat WAL, tool-vault bridge) should
     * pass false for ~5-30× faster perceived ingest latency.
     *
     * To wait for background work to drain (tests, shutdown), call
     * `flushPendingSideEffects()` from this module.
     */
    awaitSideEffects?: boolean;
}
/**
 * Wait for all in-flight background side-effects (KG extraction +
 * daily-entry append fired with `awaitSideEffects: false`) to
 * complete. No-op when nothing is pending.
 *
 * Tests should call this between ingest and assert; shutdown code
 * should call before process exit to avoid losing KG writes.
 */
export declare function flushPendingSideEffects(): Promise<void>;
/** Pending count — for tests + telemetry. */
export declare function pendingSideEffectCount(): number;
/**
 * Immediately persist one or more memory entries.
 * Designed to be called mid-conversation, before the agent responds.
 */
/**
 * Some MCP clients bleed the tool call's closing tag and the next parameter's opening into a
 * multi-line content value. Measured on a live store: 113 chunks carried it. Strip it before
 * anything is stored rather than at every reader.
 */
export declare function stripLeakedMarkup(content: string): string;
export declare function ingest(config: SmartMemoryConfig, storage: Storage, entries: IngestEntry[]): Promise<StoredChunk[]>;
