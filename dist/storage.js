import * as lancedb from '@lancedb/lancedb';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
// ── LanceDB Storage ──────────────────────────────────────────────────
export class Storage {
    db;
    chunks;
    dailyLogs;
    rules;
    triples;
    dbPath;
    ready;
    constructor(dataDir) {
        this.dbPath = join(dataDir, 'lance');
        if (!existsSync(dataDir))
            mkdirSync(dataDir, { recursive: true });
        this.ready = this.initAsync();
    }
    async initAsync() {
        this.db = await lancedb.connect(this.dbPath);
        const tableNames = await this.db.tableNames();
        // ── Chunks table ─────────────────────────────────────────────
        if (tableNames.includes('chunks')) {
            this.chunks = await this.db.openTable('chunks');
        }
        else {
            this.chunks = await this.db.createTable('chunks', [{
                    id: '__init__',
                    tier: 'daily',
                    content: '',
                    type: 'fact',
                    cognitive_layer: 'semantic',
                    tags: '[]',
                    domain: '',
                    topic: '',
                    source: '',
                    importance: 0.5,
                    sentiment: 'neutral',
                    created_at: new Date().toISOString(),
                    last_recalled_at: '',
                    recall_count: 0,
                    embedding: new Array(384).fill(0),
                    related_memories: '[]',
                    recall_outcomes: '[]',
                    stability: 1.0,
                    difficulty: 0.3,
                    temporal_anchor: 0,
                    consolidation_level: 0,
                    source_chunk_ids: '[]',
                    embedding_version: 1,
                    parent_chunk_id: '',
                }]);
            await this.chunks.delete('id = \'__init__\'');
        }
        // ── Daily logs table ─────────────────────────────────────────
        if (tableNames.includes('daily_logs')) {
            this.dailyLogs = await this.db.openTable('daily_logs');
        }
        else {
            this.dailyLogs = await this.db.createTable('daily_logs', [{
                    row_id: '__init__',
                    date: '',
                    timestamp: '',
                    conversation_id: '',
                    summary: '',
                    extracted_facts: '[]',
                }]);
            await this.dailyLogs.delete('row_id = \'__init__\'');
        }
        // ── Rules table ──────────────────────────────────────────────
        if (tableNames.includes('rules')) {
            this.rules = await this.db.openTable('rules');
        }
        else {
            this.rules = await this.db.createTable('rules', [{
                    id: '__init__',
                    rule: '',
                    domain: 'general',
                    confidence: 0.5,
                    reinforcements: 0,
                    contradictions: 0,
                    evidence: '[]',
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                }]);
            await this.rules.delete('id = \'__init__\'');
        }
        // ── Knowledge triples table ─────────────────────────────────
        if (tableNames.includes('knowledge_triples')) {
            this.triples = await this.db.openTable('knowledge_triples');
        }
        else {
            this.triples = await this.db.createTable('knowledge_triples', [{
                    id: '__init__',
                    subject: '',
                    predicate: '',
                    object: '',
                    source: '',
                    confidence: 0.5,
                    valid_from: new Date().toISOString(),
                    valid_to: '',
                    created_at: new Date().toISOString(),
                }]);
            await this.triples.delete('id = \'__init__\'');
        }
    }
    async ensureReady() {
        await this.ready;
    }
    // ── Chunk Operations ───────────────────────────────────────────────
    async saveChunk(chunk) {
        try {
            await this.chunks.delete(`id = '${esc(chunk.id)}'`);
        }
        catch { /* noop */ }
        await this.chunks.add([{
                id: chunk.id,
                tier: chunk.tier,
                content: chunk.content,
                type: chunk.type,
                cognitive_layer: chunk.cognitiveLayer,
                tags: JSON.stringify(chunk.tags),
                domain: chunk.domain ?? '',
                topic: chunk.topic ?? '',
                source: chunk.source,
                importance: chunk.importance,
                sentiment: chunk.sentiment,
                created_at: chunk.createdAt,
                last_recalled_at: chunk.lastRecalledAt ?? '',
                recall_count: chunk.recallCount,
                embedding: chunk.embedding ?? new Array(384).fill(0),
                related_memories: JSON.stringify(chunk.relatedMemories),
                recall_outcomes: JSON.stringify(chunk.recallOutcomes),
                stability: chunk.stability ?? 1.0,
                difficulty: chunk.difficulty ?? 0.3,
                temporal_anchor: chunk.temporalAnchor ?? 0,
                consolidation_level: chunk.consolidationLevel ?? 0,
                source_chunk_ids: JSON.stringify(chunk.sourceChunkIds ?? []),
                embedding_version: chunk.embeddingVersion ?? 1,
                parent_chunk_id: chunk.parentChunkId ?? '',
            }]);
    }
    async getChunk(id) {
        const rows = await this.chunks.query()
            .where(`id = '${esc(id)}'`)
            .limit(1)
            .toArray();
        return rows.length > 0 ? rowToChunk(rows[0]) : null;
    }
    async deleteChunk(id) {
        await this.chunks.delete(`id = '${esc(id)}'`);
    }
    async listChunks(opts) {
        let q = this.chunks.query();
        const conditions = [];
        if (opts?.excludeTiers && opts.excludeTiers.length > 0) {
            for (const t of opts.excludeTiers) {
                conditions.push(`tier != '${esc(t)}'`);
            }
        }
        if (opts?.tier) {
            conditions.push(`tier = '${esc(opts.tier)}'`);
        }
        if (opts?.cognitiveLayer) {
            conditions.push(`cognitive_layer = '${esc(opts.cognitiveLayer)}'`);
        }
        if (opts?.domain) {
            conditions.push(`domain = '${esc(opts.domain)}'`);
        }
        if (opts?.topic) {
            conditions.push(`topic = '${esc(opts.topic)}'`);
        }
        if (conditions.length > 0) {
            q = q.where(conditions.join(' AND '));
        }
        const rows = await q.toArray();
        return rows.map(rowToChunk);
    }
    async updateChunk(id, updates) {
        const values = {};
        if (updates.tier !== undefined)
            values.tier = updates.tier;
        if (updates.content !== undefined)
            values.content = updates.content;
        if (updates.importance !== undefined)
            values.importance = updates.importance;
        if (updates.recallCount !== undefined)
            values.recall_count = updates.recallCount;
        if (updates.lastRecalledAt !== undefined)
            values.last_recalled_at = updates.lastRecalledAt ?? '';
        if (updates.relatedMemories !== undefined)
            values.related_memories = JSON.stringify(updates.relatedMemories);
        if (updates.recallOutcomes !== undefined)
            values.recall_outcomes = JSON.stringify(updates.recallOutcomes);
        if (updates.embedding !== undefined)
            values.embedding = updates.embedding ?? new Array(384).fill(0);
        if (updates.domain !== undefined)
            values.domain = updates.domain;
        if (updates.topic !== undefined)
            values.topic = updates.topic;
        // v2 fields
        if (updates.stability !== undefined)
            values.stability = updates.stability;
        if (updates.difficulty !== undefined)
            values.difficulty = updates.difficulty;
        if (updates.temporalAnchor !== undefined)
            values.temporal_anchor = updates.temporalAnchor;
        if (updates.consolidationLevel !== undefined)
            values.consolidation_level = updates.consolidationLevel;
        if (updates.sourceChunkIds !== undefined)
            values.source_chunk_ids = JSON.stringify(updates.sourceChunkIds);
        if (updates.embeddingVersion !== undefined)
            values.embedding_version = updates.embeddingVersion;
        if (updates.parentChunkId !== undefined)
            values.parent_chunk_id = updates.parentChunkId;
        if (Object.keys(values).length === 0)
            return;
        await this.chunks.update({ where: `id = '${esc(id)}'`, values });
    }
    async chunkCount() {
        return await this.chunks.countRows();
    }
    async vectorSearch(queryEmbedding, limit, filter) {
        let q = this.chunks
            .vectorSearch(queryEmbedding)
            .distanceType('cosine')
            .limit(limit);
        if (filter) {
            q = q.where(filter);
        }
        const rows = await q.toArray();
        return rows.map(row => ({
            chunk: rowToChunk(row),
            distance: row._distance ?? 1,
        }));
    }
    // ── Taxonomy ──────────────────────────────────────────────────────
    async getTaxonomy() {
        const chunks = await this.listChunks({ excludeTiers: ['archive'] });
        const tree = {};
        for (const c of chunks) {
            const d = c.domain || '(uncategorized)';
            const t = c.topic || '(general)';
            if (!tree[d])
                tree[d] = {};
            tree[d][t] = (tree[d][t] ?? 0) + 1;
        }
        return tree;
    }
    // ── Daily Logs ─────────────────────────────────────────────────────
    async appendDailyEntry(date, entry) {
        await this.dailyLogs.add([{
                row_id: `${date}-${Date.now()}`,
                date,
                timestamp: entry.timestamp,
                conversation_id: entry.conversationId,
                summary: entry.summary,
                extracted_facts: JSON.stringify(entry.extractedFacts),
            }]);
    }
    async getDailyLogs(daysBack) {
        const cutoff = new Date(Date.now() - daysBack * 86_400_000).toISOString().split('T')[0];
        const rows = await this.dailyLogs.query()
            .where(`date >= '${esc(cutoff)}'`)
            .toArray();
        const grouped = new Map();
        for (const row of rows) {
            const entries = grouped.get(row.date) ?? [];
            entries.push({
                timestamp: row.timestamp,
                conversationId: row.conversation_id,
                summary: row.summary,
                extractedFacts: JSON.parse(row.extracted_facts),
            });
            grouped.set(row.date, entries);
        }
        return Array.from(grouped.entries()).map(([date, entries]) => ({ date, entries }));
    }
    // ── Procedural Rules ───────────────────────────────────────────────
    async saveRule(rule) {
        try {
            await this.rules.delete(`id = '${esc(rule.id)}'`);
        }
        catch { /* noop */ }
        await this.rules.add([{
                id: rule.id,
                rule: rule.rule,
                domain: rule.domain,
                confidence: rule.confidence,
                reinforcements: rule.reinforcements,
                contradictions: rule.contradictions,
                evidence: JSON.stringify(rule.evidence),
                created_at: rule.createdAt,
                updated_at: rule.updatedAt,
            }]);
    }
    async getRules() {
        const rows = await this.rules.query().toArray();
        return rows
            .map(r => ({
            id: r.id,
            rule: r.rule,
            domain: r.domain,
            confidence: r.confidence,
            reinforcements: r.reinforcements,
            contradictions: r.contradictions,
            evidence: JSON.parse(r.evidence),
            createdAt: r.created_at,
            updatedAt: r.updated_at,
        }))
            .sort((a, b) => b.confidence - a.confidence);
    }
    async deleteRule(id) {
        await this.rules.delete(`id = '${esc(id)}'`);
    }
    // ── Knowledge Triples ─────────────────────────────────────────────
    async saveTriple(triple) {
        try {
            await this.triples.delete(`id = '${esc(triple.id)}'`);
        }
        catch { /* noop */ }
        await this.triples.add([{
                id: triple.id,
                subject: triple.subject,
                predicate: triple.predicate,
                object: triple.object,
                source: triple.source,
                confidence: triple.confidence,
                valid_from: triple.validFrom,
                valid_to: triple.validTo ?? '',
                created_at: triple.createdAt,
            }]);
    }
    async queryTriples(opts) {
        let q = this.triples.query();
        const conditions = [];
        if (opts?.subject)
            conditions.push(`subject = '${esc(opts.subject)}'`);
        if (opts?.predicate)
            conditions.push(`predicate = '${esc(opts.predicate)}'`);
        if (opts?.object)
            conditions.push(`object = '${esc(opts.object)}'`);
        if (opts?.activeOnly)
            conditions.push(`valid_to = ''`);
        if (conditions.length > 0) {
            q = q.where(conditions.join(' AND '));
        }
        const rows = await q.toArray();
        return rows.map(rowToTriple);
    }
    async invalidateTriple(id) {
        await this.triples.update({
            where: `id = '${esc(id)}'`,
            values: { valid_to: new Date().toISOString() },
        });
    }
    async getTripleTimeline(entity) {
        const asSubject = await this.triples.query()
            .where(`subject = '${esc(entity)}'`)
            .toArray();
        const asObject = await this.triples.query()
            .where(`object = '${esc(entity)}'`)
            .toArray();
        return [...asSubject, ...asObject]
            .map(rowToTriple)
            .sort((a, b) => new Date(a.validFrom).getTime() - new Date(b.validFrom).getTime());
    }
    async getTripleStats() {
        const all = await this.triples.query().toArray();
        const triples = all.map(rowToTriple);
        const active = triples.filter(t => !t.validTo);
        const subjects = new Set(triples.map(t => t.subject));
        const predicates = new Set(triples.map(t => t.predicate));
        return {
            total: triples.length,
            active: active.length,
            invalidated: triples.length - active.length,
            subjects: subjects.size,
            predicates: predicates.size,
        };
    }
    // ── Lifecycle ──────────────────────────────────────────────────────
    close() {
        // LanceDB connections don't need explicit closing in the JS driver
    }
}
// ── Helpers ──────────────────────────────────────────────────────────
function esc(val) {
    return val.replace(/'/g, "''");
}
function rowToChunk(row) {
    let embedding;
    if (row.embedding) {
        embedding = Array.isArray(row.embedding) ? row.embedding : Array.from(row.embedding);
        if (embedding && embedding.every(v => v === 0))
            embedding = undefined;
    }
    return {
        id: row.id,
        tier: row.tier,
        content: row.content,
        type: row.type,
        cognitiveLayer: row.cognitive_layer,
        tags: JSON.parse(row.tags ?? '[]'),
        domain: row.domain ?? '',
        topic: row.topic ?? '',
        source: row.source ?? '',
        importance: row.importance ?? 0.5,
        sentiment: row.sentiment ?? 'neutral',
        createdAt: row.created_at,
        lastRecalledAt: row.last_recalled_at || null,
        recallCount: row.recall_count ?? 0,
        embedding,
        relatedMemories: JSON.parse(row.related_memories ?? '[]'),
        recallOutcomes: JSON.parse(row.recall_outcomes ?? '[]'),
        // v2 fields (backward-compatible defaults)
        stability: row.stability ?? 1.0,
        difficulty: row.difficulty ?? 0.3,
        temporalAnchor: row.temporal_anchor ?? undefined,
        consolidationLevel: row.consolidation_level ?? 0,
        sourceChunkIds: row.source_chunk_ids ? JSON.parse(row.source_chunk_ids) : undefined,
        embeddingVersion: row.embedding_version ?? 1,
        parentChunkId: row.parent_chunk_id || undefined,
    };
}
function rowToTriple(row) {
    return {
        id: row.id,
        subject: row.subject,
        predicate: row.predicate,
        object: row.object,
        source: row.source ?? '',
        confidence: row.confidence ?? 0.5,
        validFrom: row.valid_from,
        validTo: row.valid_to || null,
        createdAt: row.created_at,
    };
}
//# sourceMappingURL=storage.js.map