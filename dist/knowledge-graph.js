import { randomUUID } from 'node:crypto';
/**
 * Knowledge graph -- entity-relationship triples with temporal validity.
 *
 * Each triple is (subject, predicate, object) with valid_from/valid_to
 * timestamps. Facts can be invalidated when they change without losing
 * the historical record.
 *
 * Examples:
 *   ("Matt", "works-at", "Acme Corp", valid_from: 2024-01, valid_to: 2025-06)
 *   ("Matt", "works-at", "NewCo", valid_from: 2025-06, valid_to: null)
 *   ("finch-core", "uses", "TypeScript")
 *   ("engram", "depends-on", "LanceDB")
 */
export async function addTriple(storage, subject, predicate, object, source, confidence) {
    // Check for existing active triple with same subject+predicate+object
    const existing = await storage.queryTriples({
        subject,
        predicate,
        object,
        activeOnly: true,
    });
    if (existing.length > 0) {
        // Already exists and active -- bump confidence
        const triple = existing[0];
        const updated = {
            ...triple,
            confidence: Math.min(1.0, (triple.confidence ?? 0.5) + 0.1),
        };
        await storage.saveTriple(updated);
        return updated;
    }
    const triple = {
        id: randomUUID(),
        subject: subject.trim(),
        predicate: predicate.trim().toLowerCase(),
        object: object.trim(),
        source: source ?? '',
        confidence: confidence ?? 0.5,
        validFrom: new Date().toISOString(),
        validTo: null,
        createdAt: new Date().toISOString(),
    };
    await storage.saveTriple(triple);
    return triple;
}
/**
 * Add a triple and automatically invalidate conflicting ones.
 * Useful for updating facts: ("Matt", "works-at", "NewCo") invalidates
 * any existing active ("Matt", "works-at", *) triples.
 */
export async function replaceTriple(storage, subject, predicate, object, source, confidence) {
    // Invalidate all active triples with the same subject+predicate
    const existing = await storage.queryTriples({
        subject,
        predicate,
        activeOnly: true,
    });
    for (const triple of existing) {
        if (triple.object !== object) {
            await storage.invalidateTriple(triple.id);
        }
    }
    return addTriple(storage, subject, predicate, object, source, confidence);
}
/**
 * Query the knowledge graph.
 */
export async function queryGraph(storage, opts) {
    return storage.queryTriples(opts);
}
/**
 * Get the full timeline of an entity (as subject or object).
 */
export async function getTimeline(storage, entity) {
    return storage.getTripleTimeline(entity);
}
/**
 * Invalidate a triple (mark it as no longer valid).
 */
export async function invalidateTriple(storage, tripleId) {
    await storage.invalidateTriple(tripleId);
}
/**
 * Get knowledge graph stats.
 */
export async function getGraphStats(storage) {
    return storage.getTripleStats();
}
/**
 * Format active triples for context injection.
 */
export async function formatGraphForPrompt(storage, entity) {
    const triples = entity
        ? await storage.getTripleTimeline(entity)
        : await storage.queryTriples({ activeOnly: true });
    const active = triples.filter(t => !t.validTo);
    if (active.length === 0)
        return '';
    const lines = active.map(t => `- ${t.subject} ${t.predicate} ${t.object}`);
    return `\n--- KNOWLEDGE GRAPH ---\n${lines.join('\n')}\n`;
}
//# sourceMappingURL=knowledge-graph.js.map