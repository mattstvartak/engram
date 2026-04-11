/**
 * Sub-session chunking for long content.
 *
 * Splits long memories into focused sub-chunks so each produces
 * a distinct embedding instead of averaging over many topics.
 * Short content (< splitThreshold) passes through unchanged.
 */
const DEFAULTS = {
    minChunkLength: 200,
    maxChunkLength: 600,
    splitThreshold: 500,
};
/**
 * Split long content into focused sub-chunks.
 *
 * Strategy:
 *  1. Split on paragraph boundaries (\n\n)
 *  2. If single paragraph, split on speaker turns (conversation transcripts)
 *  3. Merge small adjacent fragments
 *  4. Split oversized fragments at sentence boundaries
 */
export function chunkContent(content, opts) {
    const { minChunkLength, maxChunkLength, splitThreshold } = { ...DEFAULTS, ...opts };
    const trimmed = content.trim();
    if (trimmed.length < splitThreshold) {
        return { chunks: [trimmed], needsSplit: false };
    }
    // Step 1: Split on paragraph boundaries
    let fragments = trimmed.split(/\n\n+/).map(f => f.trim()).filter(f => f.length > 0);
    // Step 2: If single paragraph, try speaker-turn splitting (conversation transcripts)
    if (fragments.length === 1) {
        const turnSplit = splitOnSpeakerTurns(fragments[0], maxChunkLength);
        if (turnSplit.length > 1) {
            fragments = turnSplit;
        }
        else {
            // Fall back to sentence splitting
            fragments = splitAtSentences(fragments[0], maxChunkLength);
        }
    }
    // Step 3: Merge small adjacent fragments
    fragments = mergeSmallFragments(fragments, minChunkLength, maxChunkLength);
    // Step 4: Split any oversized fragments at sentence boundaries
    const result = [];
    for (const frag of fragments) {
        if (frag.length > maxChunkLength) {
            result.push(...splitAtSentences(frag, maxChunkLength));
        }
        else {
            result.push(frag);
        }
    }
    // Final merge pass for any tiny leftovers from sentence splitting
    const final = mergeSmallFragments(result, minChunkLength, maxChunkLength);
    if (final.length <= 1) {
        return { chunks: [trimmed], needsSplit: false };
    }
    return { chunks: final, needsSplit: true };
}
/**
 * Split conversation text on speaker turn boundaries.
 * Groups consecutive turns to stay within maxLength.
 */
function splitOnSpeakerTurns(text, maxLength) {
    const speakerPattern = /^[A-Z][a-zA-Z\s'-]*:\s/m;
    const lines = text.split('\n');
    const groups = [];
    let current = [];
    for (const line of lines) {
        if (speakerPattern.test(line) && current.length > 0) {
            const joined = current.join('\n');
            if (joined.length > maxLength && current.length > 1) {
                // Current group is too large, flush it
                groups.push(joined);
                current = [line];
            }
            else {
                current.push(line);
            }
        }
        else {
            current.push(line);
        }
        // Check if current group exceeds max
        const currentJoined = current.join('\n');
        if (currentJoined.length > maxLength && current.length > 1) {
            // Remove last line, flush, start new group
            const last = current.pop();
            groups.push(current.join('\n'));
            current = [last];
        }
    }
    if (current.length > 0) {
        groups.push(current.join('\n'));
    }
    return groups.filter(g => g.trim().length > 0);
}
/**
 * Split text at sentence boundaries, keeping chunks under maxLength.
 */
function splitAtSentences(text, maxLength) {
    const sentences = text.split(/(?<=[.!?])\s+/);
    const chunks = [];
    let current = '';
    for (const sentence of sentences) {
        const candidate = current ? current + ' ' + sentence : sentence;
        if (candidate.length > maxLength && current.length > 0) {
            chunks.push(current.trim());
            current = sentence;
        }
        else {
            current = candidate;
        }
    }
    if (current.trim().length > 0) {
        chunks.push(current.trim());
    }
    return chunks;
}
/**
 * Merge adjacent fragments that are below minLength.
 */
function mergeSmallFragments(fragments, minLength, maxLength) {
    if (fragments.length <= 1)
        return fragments;
    const result = [];
    let buffer = fragments[0];
    for (let i = 1; i < fragments.length; i++) {
        const merged = buffer + '\n\n' + fragments[i];
        if (buffer.length < minLength && merged.length <= maxLength) {
            buffer = merged;
        }
        else {
            result.push(buffer);
            buffer = fragments[i];
        }
    }
    result.push(buffer);
    return result;
}
//# sourceMappingURL=chunker.js.map