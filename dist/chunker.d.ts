/**
 * Sub-session chunking for long content.
 *
 * Splits long memories into focused sub-chunks so each produces
 * a distinct embedding instead of averaging over many topics.
 * Short content (< splitThreshold) passes through unchanged.
 */
export interface ChunkSplitResult {
    chunks: string[];
    needsSplit: boolean;
}
export interface ChunkerOptions {
    /** Minimum sub-chunk length in characters (default: 200) */
    minChunkLength?: number;
    /** Maximum sub-chunk length in characters (default: 600) */
    maxChunkLength?: number;
    /** Content length threshold to trigger splitting (default: 500) */
    splitThreshold?: number;
}
/**
 * Split long content into focused sub-chunks.
 *
 * Strategy:
 *  1. Split on paragraph boundaries (\n\n)
 *  2. If single paragraph, split on speaker turns (conversation transcripts)
 *  3. Merge small adjacent fragments
 *  4. Split oversized fragments at sentence boundaries
 */
export declare function chunkContent(content: string, opts?: ChunkerOptions): ChunkSplitResult;
