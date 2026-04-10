import type { MemoryChunk, MemoryEdge, RecallOutcome, DailyLogEntry, MemoryTier, ProceduralRule, KnowledgeTriple } from './types.js';
export interface StoredChunk extends MemoryChunk {
    relatedMemories: MemoryEdge[];
    recallOutcomes: RecallOutcome[];
}
export declare class Storage {
    private db;
    private chunks;
    private dailyLogs;
    private rules;
    private triples;
    private dbPath;
    private ready;
    constructor(dataDir: string);
    private initAsync;
    ensureReady(): Promise<void>;
    saveChunk(chunk: StoredChunk): Promise<void>;
    getChunk(id: string): Promise<StoredChunk | null>;
    deleteChunk(id: string): Promise<void>;
    listChunks(opts?: {
        excludeTiers?: MemoryTier[];
        tier?: MemoryTier;
        cognitiveLayer?: string;
        domain?: string;
        topic?: string;
    }): Promise<StoredChunk[]>;
    updateChunk(id: string, updates: Partial<StoredChunk>): Promise<void>;
    chunkCount(): Promise<number>;
    vectorSearch(queryEmbedding: number[], limit: number, filter?: string): Promise<Array<{
        chunk: StoredChunk;
        distance: number;
    }>>;
    getTaxonomy(): Promise<Record<string, Record<string, number>>>;
    appendDailyEntry(date: string, entry: DailyLogEntry): Promise<void>;
    getDailyLogs(daysBack: number): Promise<Array<{
        date: string;
        entries: DailyLogEntry[];
    }>>;
    saveRule(rule: ProceduralRule): Promise<void>;
    getRules(): Promise<ProceduralRule[]>;
    deleteRule(id: string): Promise<void>;
    saveTriple(triple: KnowledgeTriple): Promise<void>;
    queryTriples(opts?: {
        subject?: string;
        predicate?: string;
        object?: string;
        activeOnly?: boolean;
    }): Promise<KnowledgeTriple[]>;
    invalidateTriple(id: string): Promise<void>;
    getTripleTimeline(entity: string): Promise<KnowledgeTriple[]>;
    getTripleStats(): Promise<{
        total: number;
        active: number;
        invalidated: number;
        subjects: number;
        predicates: number;
    }>;
    close(): void;
}
