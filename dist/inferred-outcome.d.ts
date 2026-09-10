/**
 * Inferred recall outcomes.
 *
 * The recall feedback loop (recordRecallOutcome) was only ever fed by an agent
 * calling memory-outcome by hand, and agents do not. Measured over one working
 * session: five memory-search calls, seven memory-ingest calls, zero outcomes.
 * Every promotion and decay decision downstream of that signal was starved.
 *
 * This module grades searches mechanically from the Claude Code transcript,
 * the same way the stop hook builds a checkpoint: no LLM, one pass over the
 * JSONL. For each memory-search result set it asks one question of everything
 * the assistant produced afterwards: did distinctive material from this chunk
 * show up in what the assistant said or did? A file path, an identifier, an
 * id, a number, a proper noun. Enough of that and the chunk was used; none of
 * it and the chunk was returned for nothing.
 *
 * It infers only "helpful" and "irrelevant". "corrected" means the memory was
 * wrong, which a substring heuristic cannot tell from a memory that was merely
 * unused, so that stays explicit.
 *
 * Limits, stated so nobody over-trusts it: an assistant that quotes a search
 * result back to the user without acting on it reads as helpful. The signal
 * that matters most is the negative one, because until now nothing was ever
 * marked irrelevant at all.
 */
import type { SmartMemoryConfig } from './types.js';
import type { Storage } from './storage.js';
export interface RecalledChunk {
    id: string;
    content: string;
}
export interface ParsedSearch {
    toolUseId: string;
    query: string;
    /** Index of the assistant turn that issued the search. */
    turn: number;
    chunks: RecalledChunk[];
}
export interface ParsedTranscript {
    searches: ParsedSearch[];
    /** One entry per assistant turn: its text plus the inputs of the tools it called. */
    assistantTurns: string[];
}
export interface GradedSearch {
    toolUseId: string;
    query: string;
    helpful: string[];
    irrelevant: string[];
}
export interface GradeOptions {
    /** A search is graded once this many assistant turns have followed it. */
    minTurnsAfter?: number;
    /** Grade everything regardless of maturity; for session end. */
    final?: boolean;
}
export interface GradeSummary {
    /** Searches graded on this run. */
    graded: number;
    /** Chunks marked helpful across those searches; a search returns several chunks. */
    helpful: number;
    /** Chunks marked irrelevant across those searches. */
    irrelevant: number;
    immature: number;
    alreadyGraded: number;
}
export declare function parseTranscript(lines: string[]): ParsedTranscript;
/**
 * Pull the tokens from a memory that are unlikely to appear in unrelated text, each with a
 * weight for how strong a match it is. A path or an id on its own is enough to call a chunk
 * used; a proper noun is not.
 */
export declare function distinctiveTokens(content: string): Map<string, number>;
export declare function chunkWasUsed(content: string, laterOutput: string): boolean;
/**
 * Grade every mature search in a parsed transcript. Pure: no storage, no state file.
 */
export declare function gradeSearches(parsed: ParsedTranscript, opts?: GradeOptions): {
    graded: GradedSearch[];
    immature: number;
};
export declare function readGradedState(dataDir: string, sessionId: string): Set<string>;
export declare function writeGradedState(dataDir: string, sessionId: string, ids: Set<string>): void;
/**
 * The whole loop for one transcript. Parses first and opens storage only when there is
 * something new to record, so the per-turn hook stays cheap when nothing has matured.
 */
export declare function gradeTranscript(config: SmartMemoryConfig, openStorage: () => Promise<Storage>, transcriptPath: string, sessionId: string, opts?: GradeOptions & {
    dryRun?: boolean;
}): Promise<GradeSummary>;
