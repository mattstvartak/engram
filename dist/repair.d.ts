/**
 * Store repairs that the measurements asked for.
 *
 * Re-ingest: a long memory is stored as a whole parent plus child pieces, and the chunker used
 * to cut those pieces at "(e.g." or inside a backticked command. The parent always held the
 * whole text, so nothing was lost, but the cut children were noise. A memory whose pieces are
 * cut is re-ingested from its whole text through the normal path, which embeds it fresh and
 * derives the pieces again with the fixed splitter; the old parent and pieces are deleted.
 * Pieces are deduplicated first because a parent contains its own children.
 *
 * Floor: corrections and preferences the user stated explicitly had decayed to the 0.15 floor,
 * 314 of them, and were losing retrieval to passing notes. The consolidator now floors them at
 * INSTRUCTION_FLOOR; this lifts the ones already below it.
 */
import type { SmartMemoryConfig } from './types.js';
import type { Storage, StoredChunk } from './storage.js';
export interface RejoinGroup {
    source: string;
    ids: string[];
    mergedLength: number;
    /** True when the first piece is cut mid-sentence, which is what makes the group worth rejoining. */
    cut: boolean;
}
export interface RepairReport {
    groupsConsidered: number;
    groupsRejoined: number;
    piecesRemoved: number;
    floored: number;
    /** Derived consolidation summaries that ended mid-word and were trimmed to their last whole sentence, or deleted when none remained. */
    summariesTrimmed: number;
    summariesDeleted: number;
    dryRun: boolean;
}
/** The source a re-ingested memory carries: the original with one marker, never a chain of them. */
export declare function rejoinedSource(source: string | undefined): string | undefined;
/** Prose that stops before its sentence ends. Right for summaries, too broad for pieces. */
export declare function isCut(content: string): boolean;
/**
 * A piece the old splitter damaged: cut at an abbreviation, inside a bracket, or inside a
 * backticked span. A piece that merely ends on a heading or a bullet without a period is not
 * damaged, and treating it as such made the repair re-ingest the same memories on every run.
 */
export declare function isCutPiece(content: string): boolean;
/**
 * Groups of pieces worth rejoining: same source, created within `windowMs` of each other, first
 * piece cut, merged length inside `maxMerged`. Pure, so it can be tested and dry-run.
 */
export declare function rejoinGroups(chunks: StoredChunk[], opts?: {
    windowMs?: number;
    maxMerged?: number;
}): RejoinGroup[];
/**
 * A source id groups everything written in one flush, and some flushes stored the same memory
 * more than once. Measured after a first repair: the largest rejoined memory held the same
 * passages three times. Drop a piece that equals, contains, or is contained in one already kept.
 */
export declare function dedupePieces(pieces: StoredChunk[]): StoredChunk[];
export declare function mergeContent(pieces: StoredChunk[]): string;
export declare function repairStore(config: SmartMemoryConfig, storage: Storage, opts?: {
    dryRun?: boolean;
}): Promise<RepairReport>;
