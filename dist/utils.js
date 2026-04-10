// ── Token Estimation ─────────────────────────────────────────────────
export function estimateTokens(text) {
    // ~4 chars per token is a reasonable English approximation
    return Math.ceil(text.length / 4);
}
// ── Cosine Similarity ────────────────────────────────────────────────
export function cosineSimilarity(a, b) {
    if (a.length !== b.length)
        return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
}
// ── Duplicate Detection ──────────────────────────────────────────────
// Simple heuristic: normalize and check for high word overlap.
export function isDuplicate(content, existing) {
    const normalized = content.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
    const words = new Set(normalized.split(/\s+/));
    if (words.size < 3)
        return false;
    for (const chunk of existing) {
        const existingNorm = chunk.content.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
        const existingWords = new Set(existingNorm.split(/\s+/));
        // Jaccard similarity
        let intersection = 0;
        for (const w of words) {
            if (existingWords.has(w))
                intersection++;
        }
        const union = new Set([...words, ...existingWords]).size;
        if (union > 0 && intersection / union > 0.75)
            return true;
    }
    return false;
}
// ── Edge Utilities ───────────────────────────────────────────────────
export function getEdgeTargetIds(edges) {
    return edges.map(e => e.targetId);
}
export function addEdge(edges, targetId, relationship, weight = 0.5) {
    if (edges.some(e => e.targetId === targetId))
        return edges;
    return [...edges, { targetId, relationship, weight, createdAt: new Date().toISOString() }];
}
export function strengthenEdge(edges, targetId, delta) {
    return edges.map(e => e.targetId === targetId
        ? { ...e, weight: Math.min(1.0, e.weight + delta) }
        : e);
}
//# sourceMappingURL=utils.js.map