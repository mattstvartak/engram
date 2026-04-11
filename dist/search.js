import { embed, llmComplete } from './llm.js';
import { estimateTokens } from './utils.js';
import { rerank } from './reranker.js';
/**
 * Hybrid memory search: native ANN vector search (LanceDB) + keyword
 * with IDF weighting + temporal/entity/phrase boosting + spreading activation.
 */
export async function search(config, storage, query, maxResults, filters) {
    const limit = maxResults ?? config.maxRecallChunks;
    const allChunks = await storage.listChunks({
        excludeTiers: ['archive'],
        domain: filters?.domain,
        topic: filters?.topic,
    });
    if (allChunks.length === 0)
        return [];
    const scored = new Map();
    // Pre-extract query signals for boosting
    const querySignals = extractQuerySignals(query);
    const hasEntities = querySignals.entities.length > 0;
    // Build IDF weights for keyword scoring
    const idfWeights = buildIdfWeights(query, allChunks);
    // ── Native ANN vector search via LanceDB ───────────────────────────
    let queryEmbedding = null;
    try {
        // Build the same contextual prefix used at ingest time so query and
        // stored embeddings live in the same vector space.
        const queryPrefix = config.enableContextualPrefix
            ? 'search query: '
            : undefined;
        queryEmbedding = await embed(config, query, queryPrefix);
    }
    catch {
        // Fall back to keyword-only
    }
    if (queryEmbedding && queryEmbedding.length > 0) {
        const vectorResults = await storage.vectorSearch(queryEmbedding, Math.min(limit * 5, 50), // Larger candidate pool
        "tier != 'archive' AND consolidation_level != -1");
        for (const { chunk, distance } of vectorResults) {
            const similarity = 1 - distance;
            if (similarity > 0.25) {
                scored.set(chunk.id, { chunk, score: similarity });
            }
        }
    }
    // ── IDF-weighted keyword scoring ──────────────────────────────────
    // Rare terms (names, specific nouns) score much higher than common words.
    const keywordScored = new Map();
    const queryTerms = Object.keys(idfWeights);
    if (queryTerms.length > 0) {
        const totalIdfWeight = Object.values(idfWeights).reduce((a, b) => a + b, 0);
        for (const chunk of allChunks) {
            const text = `${chunk.content} ${chunk.tags.join(' ')}`.toLowerCase();
            let weightedMatches = 0;
            for (const term of queryTerms) {
                const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                if (new RegExp(`\\b${escaped}\\b`).test(text)) {
                    weightedMatches += idfWeights[term];
                }
            }
            if (weightedMatches > 0) {
                const keywordScore = weightedMatches / totalIdfWeight;
                keywordScored.set(chunk.id, { chunk, score: keywordScore });
            }
        }
    }
    // ── Propagate parent keyword hits to sub-chunks ────────────────────
    // Parent chunks (consolidationLevel=-1) have no embedding but contain
    // all keywords. When a parent matches, give its sub-chunks the score.
    const parentHits = new Map();
    for (const [id, entry] of keywordScored) {
        if (entry.chunk.consolidationLevel === -1) {
            parentHits.set(id, { score: entry.score });
        }
    }
    if (parentHits.size > 0) {
        for (const chunk of allChunks) {
            if (chunk.parentChunkId && parentHits.has(chunk.parentChunkId)) {
                const parentScore = parentHits.get(chunk.parentChunkId).score;
                const existing = keywordScored.get(chunk.id);
                if (existing) {
                    existing.score = Math.max(existing.score, parentScore);
                }
                else {
                    keywordScored.set(chunk.id, { chunk, score: parentScore });
                }
            }
        }
        // Remove parent entries from keyword results
        for (const id of parentHits.keys()) {
            keywordScored.delete(id);
        }
    }
    // ── Merge vector + keyword scores ─────────────────────────────────
    if (config.enableRRF) {
        // Reciprocal Rank Fusion: score = 1/(k+rank_vector) + 1/(k+rank_keyword)
        // Parameter-free, robust, industry standard (k=60)
        const K = 60;
        const vectorRanked = Array.from(scored.entries()).sort((a, b) => b[1].score - a[1].score);
        const keywordRanked = Array.from(keywordScored.entries()).sort((a, b) => b[1].score - a[1].score);
        const rrfScores = new Map();
        for (let rank = 0; rank < vectorRanked.length; rank++) {
            const [id, entry] = vectorRanked[rank];
            const existing = rrfScores.get(id);
            const rrfScore = 1 / (K + rank);
            if (existing) {
                existing.score += rrfScore;
            }
            else {
                rrfScores.set(id, { chunk: entry.chunk, score: rrfScore });
            }
        }
        for (let rank = 0; rank < keywordRanked.length; rank++) {
            const [id, entry] = keywordRanked[rank];
            const existing = rrfScores.get(id);
            const rrfScore = 1 / (K + rank);
            if (existing) {
                existing.score += rrfScore;
            }
            else {
                rrfScores.set(id, { chunk: entry.chunk, score: rrfScore });
            }
        }
        // Replace scored map with raw RRF scores (no normalization).
        // Bonus factors downstream are additive and small (~0.1-0.4).
        // RRF scores are already in a comparable range (max ~0.033 for k=60),
        // so normalizing to [0,1] would make bonuses disproportionately large.
        scored.clear();
        for (const [id, entry] of rrfScores) {
            scored.set(id, { chunk: entry.chunk, score: entry.score });
        }
    }
    else {
        // Legacy weighted linear blend
        for (const [id, kwEntry] of keywordScored) {
            const existing = scored.get(id);
            if (existing) {
                if (hasEntities) {
                    existing.score = existing.score * 0.5 + kwEntry.score * 0.5;
                }
                else {
                    existing.score = existing.score * 0.65 + kwEntry.score * 0.35;
                }
            }
            else {
                scored.set(id, { chunk: kwEntry.chunk, score: kwEntry.score * 0.8 });
            }
        }
    }
    // ── Bonus factors ──────────────────────────────────────────────────
    // When RRF is enabled, raw scores are ~0.003-0.033 so bonuses must be
    // in the same magnitude. Scale factor keeps bonuses proportional.
    const bonusScale = config.enableRRF ? 0.1 : 1.0;
    const now = Date.now();
    for (const [, entry] of scored) {
        const c = entry.chunk;
        const ageDays = (now - new Date(c.createdAt).getTime()) / 86_400_000;
        // Base bonuses
        entry.score += Math.max(0, 0.1 * (1 - ageDays / 30)) * bonusScale; // Recency
        entry.score += Math.min(0.05, c.recallCount * 0.01) * bonusScale; // Frequency
        entry.score += (c.tier === 'long-term' ? 0.05 : 0) * bonusScale; // Tier bonus
        entry.score += c.importance * 0.1 * bonusScale; // Importance
        if (c.cognitiveLayer === 'procedural')
            entry.score += 0.05 * bonusScale; // Procedural boost
        // ── Temporal proximity boost (up to +0.4) ────────────────────
        if (querySignals.dates.length > 0) {
            entry.score += temporalBoost(c, querySignals.dates) * bonusScale;
        }
        // ── Entity / proper noun boost (up to +0.5) ─────────────────
        if (querySignals.entities.length > 0) {
            entry.score += entityBoost(c, querySignals.entities) * bonusScale;
        }
        // ── Quoted phrase boost (up to +0.6) ─────────────────────────
        if (querySignals.phrases.length > 0) {
            entry.score += phraseBoost(c, querySignals.phrases) * bonusScale;
        }
    }
    // ── Time-window retrieval (temporal inference) ─────────────────────
    // When dates are detected, pull in memories from that time period even
    // if they didn't match semantically. This is the biggest lever for
    // temporal inference: "Where was I working in March 2024?" needs
    // memories *from* that period, not just memories *mentioning* March.
    if (querySignals.dates.length > 0 || querySignals.isTemporalInference) {
        const windows = buildTimeWindows(querySignals);
        for (const chunk of allChunks) {
            if (scored.has(chunk.id))
                continue; // Already in candidates
            const chunkTime = chunk.temporalAnchor ?? new Date(chunk.createdAt).getTime();
            for (const win of windows) {
                if (chunkTime >= win.start && chunkTime <= win.end) {
                    // Base score proportional to how close to center of window
                    const center = (win.start + win.end) / 2;
                    const halfSpan = (win.end - win.start) / 2;
                    const proximity = 1 - Math.abs(chunkTime - center) / halfSpan;
                    const windowScore = (0.3 + proximity * 0.2) * bonusScale; // scaled for RRF
                    scored.set(chunk.id, { chunk, score: windowScore });
                    break;
                }
            }
        }
    }
    // ── Knowledge graph temporal lookup ───────────────────────────────
    // When entities + time are present, query KG for facts valid at that
    // time and boost memories that reference the same subjects/objects.
    if (querySignals.isTemporalInference && querySignals.entities.length > 0) {
        try {
            const kgBoostTerms = new Set();
            for (const entity of querySignals.entities) {
                const timeline = await storage.getTripleTimeline(entity);
                for (const triple of timeline) {
                    const validFrom = new Date(triple.validFrom).getTime();
                    const validTo = triple.validTo ? new Date(triple.validTo).getTime() : now;
                    // Check if this triple was valid during any of the query dates
                    let tripleRelevant = false;
                    if (querySignals.dates.length > 0) {
                        for (const qd of querySignals.dates) {
                            const queryTime = new Date(qd.year ?? new Date().getFullYear(), (qd.month ?? 1) - 1, qd.day ?? 15).getTime();
                            if (queryTime >= validFrom && queryTime <= validTo) {
                                tripleRelevant = true;
                                break;
                            }
                        }
                    }
                    else {
                        // No specific date -- use active triples
                        tripleRelevant = !triple.validTo;
                    }
                    if (tripleRelevant) {
                        // Add the triple's subject, predicate, and object as boost terms
                        kgBoostTerms.add(triple.subject.toLowerCase());
                        kgBoostTerms.add(triple.object.toLowerCase());
                    }
                }
            }
            // Boost existing candidates that mention KG-derived terms
            if (kgBoostTerms.size > 0) {
                for (const [, entry] of scored) {
                    const contentLower = entry.chunk.content.toLowerCase();
                    let kgMatches = 0;
                    for (const term of kgBoostTerms) {
                        if (contentLower.includes(term))
                            kgMatches++;
                    }
                    if (kgMatches > 0) {
                        entry.score += Math.min(0.3, kgMatches * 0.1) * bonusScale;
                    }
                }
            }
        }
        catch {
            // KG lookup is best-effort
        }
    }
    // ── Spreading activation (graph walk) ──────────────────────────────
    const isTemporalQuery = querySignals.isTemporalInference || querySignals.dates.length > 0;
    const seeds = Array.from(scored.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
    const MAX_EDGES = 5;
    for (const parent of seeds) {
        const edges = parent.chunk.relatedMemories.slice(0, MAX_EDGES);
        for (const edge of edges) {
            // Prioritize temporal edges when query is temporal
            const edgeMultiplier = isTemporalQuery && edge.relationship === 'temporal' ? 1.5 : 1.0;
            const hop1Activation = parent.score * edge.weight * edgeMultiplier * 0.5;
            const existing = scored.get(edge.targetId);
            if (existing) {
                existing.score += parent.score * edge.weight * edgeMultiplier * 0.2;
            }
            else {
                const hop1Chunk = await storage.getChunk(edge.targetId);
                if (hop1Chunk && hop1Chunk.tier !== 'archive') {
                    scored.set(edge.targetId, { chunk: hop1Chunk, score: hop1Activation });
                    for (const hop2Edge of hop1Chunk.relatedMemories.slice(0, MAX_EDGES)) {
                        if (scored.has(hop2Edge.targetId))
                            continue;
                        const hop2Multiplier = isTemporalQuery && hop2Edge.relationship === 'temporal' ? 1.5 : 1.0;
                        const hop2Activation = parent.score * edge.weight * hop2Edge.weight * edgeMultiplier * hop2Multiplier * 0.25;
                        const hop2Chunk = await storage.getChunk(hop2Edge.targetId);
                        if (hop2Chunk && hop2Chunk.tier !== 'archive') {
                            scored.set(hop2Edge.targetId, { chunk: hop2Chunk, score: hop2Activation });
                        }
                    }
                }
            }
        }
    }
    // ── Cross-encoder reranking (Improvement 7) ────────────────────────
    let sorted;
    if (config.enableCrossEncoderRerank) {
        const candidates = Array.from(scored.values())
            .sort((a, b) => b.score - a.score)
            .slice(0, 30);
        try {
            const reranked = await rerank(query, candidates.map(c => c.chunk.content), Math.min(limit, 10));
            sorted = reranked.map(r => ({
                chunk: candidates[r.index].chunk,
                score: r.score,
            }));
        }
        catch {
            // Fall back to score-based ranking
            sorted = Array.from(scored.values())
                .sort((a, b) => b.score - a.score)
                .slice(0, 20);
        }
    }
    else {
        sorted = Array.from(scored.values())
            .sort((a, b) => b.score - a.score)
            .slice(0, 20);
    }
    // ── Apply token budget ────────────────────────────────────────────
    const results = [];
    let tokensUsed = 0;
    for (const entry of sorted) {
        const tokens = estimateTokens(entry.chunk.content) + 10;
        if (tokensUsed + tokens > config.maxRecallTokens)
            break;
        if (results.length >= limit)
            break;
        results.push({ chunk: entry.chunk, score: entry.score });
        tokensUsed += tokens;
        await storage.updateChunk(entry.chunk.id, {
            recallCount: entry.chunk.recallCount + 1,
            lastRecalledAt: new Date().toISOString(),
        });
    }
    return results;
}
// ─────────────────────────────────────────────────────────────────────
// IDF-WEIGHTED KEYWORD SCORING
// ─────────────────────────────────────────────────────────────────────
/**
 * Build IDF-like weights for query terms.
 * Terms that appear in fewer documents get higher weight.
 * Proper nouns (capitalized) get an additional boost.
 */
function buildIdfWeights(query, corpus) {
    const STOP = new Set([
        'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
        'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
        'should', 'may', 'might', 'can', 'what', 'when', 'where', 'which',
        'who', 'whom', 'how', 'why', 'that', 'this', 'these', 'those',
        'i', 'you', 'he', 'she', 'it', 'we', 'they', 'my', 'your', 'his',
        'her', 'its', 'our', 'their', 'if', 'for', 'from', 'with', 'about',
        'into', 'and', 'but', 'or', 'not', 'no', 'so', 'too', 'very', 'just',
        'also', 'than', 'both', 'any', 'all',
    ]);
    const rawTerms = query.split(/\s+/).map(t => t.replace(/[^a-zA-Z0-9'-]/g, '')).filter(t => t.length > 1);
    const terms = rawTerms.filter(t => !STOP.has(t.toLowerCase()));
    if (terms.length === 0)
        return {};
    const N = Math.max(corpus.length, 1);
    const weights = {};
    for (const term of terms) {
        const lower = term.toLowerCase();
        if (weights[lower])
            continue; // dedupe
        // Count documents containing this term
        const escaped = lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\b${escaped}\\b`);
        let df = 0;
        for (const chunk of corpus) {
            if (regex.test(chunk.content.toLowerCase()))
                df++;
        }
        // IDF: log(N / (df + 1)) -- rare terms get higher weight
        let idf = Math.log(N / (df + 1));
        // Boost proper nouns (capitalized in original query)
        if (/^[A-Z]/.test(term) && term.length > 2) {
            idf *= 1.5;
        }
        // Floor: even common terms get some weight
        weights[lower] = Math.max(0.1, idf);
    }
    return weights;
}
const MONTH_MAP = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
    jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
function extractQuerySignals(query) {
    const dates = [];
    const entities = [];
    const phrases = [];
    let isTemporalInference = false;
    let temporalRelation = null;
    // ── Date extraction ────────────────────────────────────────────
    // ISO dates: 2025-12-15
    for (const m of query.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
        dates.push({ year: +m[1], month: +m[2], day: +m[3], raw: m[0] });
    }
    // "Month YYYY" or "Month DD, YYYY"
    for (const m of query.matchAll(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(?:(\d{1,2})[,.]?\s+)?(\d{4})\b/gi)) {
        dates.push({ month: MONTH_MAP[m[1].toLowerCase()], day: m[2] ? +m[2] : undefined, year: +m[3], raw: m[0] });
    }
    // "in YYYY" or standalone year
    for (const m of query.matchAll(/\b(20[12]\d)\b/g)) {
        if (!dates.some(d => d.year === +m[1])) {
            dates.push({ year: +m[1], raw: m[0] });
        }
    }
    // Month names without year
    for (const m of query.matchAll(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/gi)) {
        if (!dates.some(d => d.raw.toLowerCase().includes(m[1].toLowerCase()))) {
            dates.push({ month: MONTH_MAP[m[1].toLowerCase()], raw: m[0] });
        }
    }
    // Relative dates
    const lower = query.toLowerCase();
    const now_date = new Date();
    if (lower.includes('yesterday')) {
        const d = new Date(Date.now() - 86_400_000);
        dates.push({ year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), raw: 'yesterday' });
    }
    if (lower.includes('today') || lower.includes('this morning') || lower.includes('tonight')) {
        dates.push({ year: now_date.getFullYear(), month: now_date.getMonth() + 1, day: now_date.getDate(), raw: 'today' });
    }
    if (lower.includes('last week')) {
        const d = new Date(Date.now() - 7 * 86_400_000);
        dates.push({ year: d.getFullYear(), month: d.getMonth() + 1, raw: 'last week' });
    }
    if (lower.includes('last month')) {
        const d = new Date(now_date.getFullYear(), now_date.getMonth() - 1, 15);
        dates.push({ year: d.getFullYear(), month: d.getMonth() + 1, raw: 'last month' });
    }
    if (lower.includes('this month')) {
        dates.push({ year: now_date.getFullYear(), month: now_date.getMonth() + 1, raw: 'this month' });
    }
    if (lower.includes('last year')) {
        dates.push({ year: now_date.getFullYear() - 1, raw: 'last year' });
    }
    if (lower.includes('this year')) {
        dates.push({ year: now_date.getFullYear(), raw: 'this year' });
    }
    // "N days/weeks/months ago"
    for (const m of lower.matchAll(/(\d+)\s+(days?|weeks?|months?)\s+ago/g)) {
        const n = parseInt(m[1], 10);
        const unit = m[2].startsWith('day') ? 86_400_000 : m[2].startsWith('week') ? 7 * 86_400_000 : 30 * 86_400_000;
        const d = new Date(Date.now() - n * unit);
        dates.push({ year: d.getFullYear(), month: d.getMonth() + 1, day: unit === 86_400_000 ? d.getDate() : undefined, raw: m[0] });
    }
    // ── Entity extraction (proper nouns) ───────────────────────────
    const STOP_WORDS = new Set([
        'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
        'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
        'should', 'may', 'might', 'shall', 'can', 'what', 'when', 'where',
        'which', 'who', 'whom', 'how', 'why', 'that', 'this', 'these', 'those',
        'i', 'you', 'he', 'she', 'it', 'we', 'they', 'my', 'your', 'his',
        'her', 'its', 'our', 'their', 'if', 'then', 'else', 'for', 'from',
        'with', 'about', 'into', 'through', 'during', 'before', 'after',
        'above', 'below', 'between', 'and', 'but', 'or', 'not', 'no', 'so',
        'too', 'very', 'just', 'also', 'than', 'some', 'any', 'all', 'each',
        'every', 'both', 'few', 'more', 'most', 'other', 'new', 'old', 'first',
        'last', 'long', 'great', 'little', 'own', 'right', 'still', 'does',
        'would', 'could', 'should', 'many', 'much', 'such', 'only',
    ]);
    const words = query.split(/\s+/);
    for (let i = 0; i < words.length; i++) {
        const word = words[i].replace(/[^a-zA-Z'-]/g, '');
        if (word.length < 2)
            continue;
        if (STOP_WORDS.has(word.toLowerCase()))
            continue;
        if (/^[A-Z][a-zA-Z'-]+$/.test(word)) {
            // Accept proper nouns even at sentence start if they look like names
            const isLikelyName = word.length >= 3 && word.length <= 20 && /^[A-Z][a-z]+$/.test(word);
            const isAfterSentenceStart = i === 0 || /[.!?]$/.test(words[i - 1] ?? '');
            if (isLikelyName || !isAfterSentenceStart) {
                entities.push(word);
            }
        }
    }
    // Multi-word entities
    for (const m of query.matchAll(/\b([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+)+)\b/g)) {
        const candidate = m[1];
        if (candidate.split(/\s+/).every(w => !STOP_WORDS.has(w.toLowerCase()))) {
            entities.push(candidate);
        }
    }
    // Entity alias expansion: "Matt" also matches "Matthew", etc.
    // Simple substring dedup -- if one entity is a prefix of another, keep both
    const expandedEntities = [...entities];
    for (const entity of entities) {
        const lower = entity.toLowerCase();
        // Common name shortenings
        for (const chunk of []) { /* KG expansion would go here */ }
        // For now, add case variations so entityBoost catches more
        if (!expandedEntities.some(e => e.toLowerCase() === lower && e !== entity)) {
            // Already have it
        }
    }
    // ── Quoted phrase extraction ───────────────────────────────────
    for (const m of query.matchAll(/"([^"]+)"/g)) {
        if (m[1].length >= 3)
            phrases.push(m[1]);
    }
    for (const m of query.matchAll(/'([^']+)'/g)) {
        if (m[1].length >= 3)
            phrases.push(m[1]);
    }
    // ── Implicit temporal language detection ────────────────────────
    // Detects queries that require reasoning across time, even without
    // explicit dates. These need time-window expansion and KG lookups.
    const temporalPatterns = [
        { pattern: /\b(?:before|prior to|leading up to|until)\b/i, relation: 'before' },
        { pattern: /\b(?:after|following|since|once .+ (?:started|happened|began))\b/i, relation: 'after' },
        { pattern: /\b(?:during|while|when .+ was|at the time|at that (?:time|point)|in the (?:midst|middle) of)\b/i, relation: 'during' },
        { pattern: /\b(?:around|about|approximately|circa)\b/i, relation: 'around' },
    ];
    for (const { pattern, relation } of temporalPatterns) {
        if (pattern.test(query)) {
            isTemporalInference = true;
            temporalRelation = temporalRelation ?? relation;
        }
    }
    // Also flag as temporal inference if query uses reasoning-across-time language
    if (/\b(?:first|then|later|earlier|previously|back then|meanwhile|still|already|yet|anymore|no longer|used to|at the same time|changed|moved|switched|started|stopped|began|ended|joined|left|quit)\b/i.test(lower)) {
        isTemporalInference = true;
    }
    // If we have dates + entities, it's likely temporal inference
    // ("Where was Matt working in March 2024?")
    if (dates.length > 0 && entities.length > 0) {
        isTemporalInference = true;
    }
    return { dates, entities, phrases, isTemporalInference, temporalRelation };
}
// ─────────────────────────────────────────────────────────────────────
// BOOST FUNCTIONS
// ─────────────────────────────────────────────────────────────────────
/**
 * Temporal proximity boost -- up to +0.4.
 */
function temporalBoost(chunk, queryDates) {
    let maxBoost = 0;
    const contentLower = chunk.content.toLowerCase();
    for (const qd of queryDates) {
        // Exact date string match in content
        if (qd.raw && contentLower.includes(qd.raw.toLowerCase())) {
            maxBoost = Math.max(maxBoost, 0.4);
            continue;
        }
        // Year + month match in content
        if (qd.month && qd.year) {
            const monthName = Object.entries(MONTH_MAP).find(([, v]) => v === qd.month)?.[0] ?? '';
            if (monthName && contentLower.includes(monthName) && chunk.content.includes(String(qd.year))) {
                maxBoost = Math.max(maxBoost, 0.35);
                continue;
            }
        }
        // Year match in content
        if (qd.year && chunk.content.includes(String(qd.year))) {
            maxBoost = Math.max(maxBoost, 0.15);
        }
        // Month name match in content
        if (qd.month) {
            const monthNames = Object.entries(MONTH_MAP)
                .filter(([, v]) => v === qd.month)
                .map(([k]) => k);
            if (monthNames.some(mn => contentLower.includes(mn))) {
                maxBoost = Math.max(maxBoost, 0.2);
            }
        }
        // Timestamp proximity (use temporalAnchor if available, falls back to createdAt)
        if (qd.year) {
            try {
                const chunkDate = chunk.temporalAnchor ? new Date(chunk.temporalAnchor) : new Date(chunk.createdAt);
                const queryDate = new Date(qd.year, (qd.month ?? 1) - 1, qd.day ?? 15);
                const daysDiff = Math.abs(chunkDate.getTime() - queryDate.getTime()) / 86_400_000;
                if (daysDiff < 1)
                    maxBoost = Math.max(maxBoost, 0.3);
                else if (daysDiff < 7)
                    maxBoost = Math.max(maxBoost, 0.2);
                else if (daysDiff < 30)
                    maxBoost = Math.max(maxBoost, 0.1);
                else if (daysDiff < 90)
                    maxBoost = Math.max(maxBoost, 0.05);
            }
            catch { /* invalid date */ }
        }
    }
    return maxBoost;
}
/**
 * Entity / proper noun boost -- up to +0.5.
 * Checks both exact and case-insensitive matches.
 */
function entityBoost(chunk, entities) {
    if (entities.length === 0)
        return 0;
    const contentLower = chunk.content.toLowerCase();
    let matched = 0;
    for (const entity of entities) {
        const escaped = entity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`\\b${escaped}\\b`, 'i').test(contentLower)) {
            matched++;
        }
    }
    if (matched === 0)
        return 0;
    // Scale: 1 match = +0.2, 2 = +0.35, 3+ = +0.5
    return Math.min(0.5, 0.1 + matched * 0.15);
}
/**
 * Quoted phrase boost -- up to +0.6.
 */
function phraseBoost(chunk, phrases) {
    if (phrases.length === 0)
        return 0;
    const contentLower = chunk.content.toLowerCase();
    let matched = 0;
    for (const phrase of phrases) {
        if (contentLower.includes(phrase.toLowerCase())) {
            matched++;
        }
    }
    if (matched === 0)
        return 0;
    return Math.min(0.6, matched * 0.3);
}
/**
 * Build time windows from parsed dates for time-window retrieval.
 * The window size adapts to date precision: specific day = +/- 3 days,
 * month = full month +/- 7 days, year = full year.
 */
function buildTimeWindows(signals) {
    const windows = [];
    for (const qd of signals.dates) {
        if (qd.year && qd.month && qd.day) {
            // Specific date: +/- 3 days
            const center = new Date(qd.year, qd.month - 1, qd.day).getTime();
            const span = 3 * 86_400_000;
            windows.push({ start: center - span, end: center + span });
        }
        else if (qd.year && qd.month) {
            // Month + year: full month +/- 7 days buffer
            const monthStart = new Date(qd.year, qd.month - 1, 1).getTime();
            const monthEnd = new Date(qd.year, qd.month, 0, 23, 59, 59).getTime();
            const buffer = 7 * 86_400_000;
            // Adjust window based on temporal relation
            if (signals.temporalRelation === 'before') {
                // "before March 2024" -- expand window earlier
                windows.push({ start: monthStart - 90 * 86_400_000, end: monthEnd });
            }
            else if (signals.temporalRelation === 'after') {
                // "after March 2024" -- expand window later
                windows.push({ start: monthStart, end: monthEnd + 90 * 86_400_000 });
            }
            else {
                windows.push({ start: monthStart - buffer, end: monthEnd + buffer });
            }
        }
        else if (qd.year) {
            // Year only: full year
            const yearStart = new Date(qd.year, 0, 1).getTime();
            const yearEnd = new Date(qd.year, 11, 31, 23, 59, 59).getTime();
            windows.push({ start: yearStart, end: yearEnd });
        }
        else if (qd.month) {
            // Month without year: assume current year, +/- 7 days
            const year = new Date().getFullYear();
            const monthStart = new Date(year, qd.month - 1, 1).getTime();
            const monthEnd = new Date(year, qd.month, 0, 23, 59, 59).getTime();
            const buffer = 7 * 86_400_000;
            windows.push({ start: monthStart - buffer, end: monthEnd + buffer });
        }
    }
    return windows;
}
// ─────────────────────────────────────────────────────────────────────
// LLM RE-RANKING
// ─────────────────────────────────────────────────────────────────────
export async function selectRelevant(config, query, candidates) {
    if (candidates.length <= 3)
        return candidates;
    const manifest = candidates.map((r, i) => `[${i}] (${r.chunk.cognitiveLayer}) ${r.chunk.content.slice(0, 200)}`).join('\n');
    try {
        const response = await llmComplete(config, 'You rerank memories by relevance to the user\'s message. Return ONLY a JSON array of ALL indices ordered from most to least relevant, e.g. [3, 0, 5, 1, 2, 4]. Include every index — do not drop any.', `User message: "${query.slice(0, 300)}"\n\nMemories:\n${manifest}`, { maxTokens: 200, temperature: 0 });
        const match = response.match(/\[[\d,\s]*\]/);
        if (match) {
            const indices = JSON.parse(match[0]);
            const seen = new Set();
            const reordered = [];
            // Add LLM-ranked results first
            for (const i of indices) {
                if (i >= 0 && i < candidates.length && !seen.has(i)) {
                    seen.add(i);
                    reordered.push(candidates[i]);
                }
            }
            // Append any the LLM missed (preserving original order)
            for (let i = 0; i < candidates.length; i++) {
                if (!seen.has(i))
                    reordered.push(candidates[i]);
            }
            return reordered;
        }
    }
    catch {
        // Fall through to original order
    }
    return candidates;
}
/**
 * Format recalled memories for system prompt injection.
 */
export function formatRecalledMemories(results) {
    if (results.length === 0)
        return '';
    const procedural = results.filter(r => r.chunk.cognitiveLayer === 'procedural');
    const semantic = results.filter(r => r.chunk.cognitiveLayer === 'semantic');
    const episodic = results.filter(r => r.chunk.cognitiveLayer === 'episodic');
    const sections = [];
    if (procedural.length > 0) {
        sections.push('## How this user works');
        sections.push(procedural.map(r => `- ${r.chunk.content}`).join('\n'));
    }
    if (semantic.length > 0) {
        sections.push('## Known facts');
        sections.push(semantic.map(r => `- [${r.chunk.type}] ${r.chunk.content}`).join('\n'));
    }
    if (episodic.length > 0) {
        sections.push('## Recent context');
        sections.push(episodic.map(r => `- ${r.chunk.content}`).join('\n'));
    }
    return `\n--- RECALLED MEMORIES ---\n${sections.join('\n\n')}\n`;
}
//# sourceMappingURL=search.js.map