export type MemoryTier = 'daily' | 'short-term' | 'long-term' | 'archive';
export type MemoryType = 'fact' | 'preference' | 'decision' | 'context' | 'correction';
export type CognitiveLayer = 'episodic' | 'semantic' | 'procedural';
export type Sentiment = 'frustrated' | 'curious' | 'satisfied' | 'neutral' | 'excited' | 'confused';
export interface MemoryChunk {
    id: string;
    tier: MemoryTier;
    content: string;
    type: MemoryType;
    cognitiveLayer: CognitiveLayer;
    tags: string[];
    domain: string;
    topic: string;
    source: string;
    importance: number;
    sentiment: Sentiment;
    createdAt: string;
    lastRecalledAt: string | null;
    recallCount: number;
    embedding?: number[];
}
export interface MemoryEdge {
    targetId: string;
    relationship: 'temporal' | 'semantic' | 'causal' | 'co-recalled';
    weight: number;
    createdAt: string;
}
export interface RecallOutcome {
    conversationId: string;
    outcome: 'helpful' | 'corrected' | 'irrelevant';
    timestamp: string;
}
export interface ProceduralRule {
    id: string;
    rule: string;
    domain: 'code' | 'communication' | 'workflow' | 'preference' | 'general';
    confidence: number;
    reinforcements: number;
    contradictions: number;
    evidence: string[];
    createdAt: string;
    updatedAt: string;
}
export interface KnowledgeTriple {
    id: string;
    subject: string;
    predicate: string;
    object: string;
    source: string;
    confidence: number;
    validFrom: string;
    validTo: string | null;
    createdAt: string;
}
export interface DiaryEntry {
    date: string;
    time: string;
    content: string;
    agent: string;
}
export interface DailyLogEntry {
    timestamp: string;
    conversationId: string;
    summary: string;
    extractedFacts: string[];
}
export interface SearchResult {
    chunk: MemoryChunk;
    score: number;
}
export interface SmartMemoryConfig {
    /** Root data directory (default: ~/.claude/smart-memory) */
    dataDir: string;
    /** Days before daily tier moves to short-term (default: 2) */
    dailyRetentionDays: number;
    /** Days before short-term promotes to long-term if recalled (default: 14) */
    shortTermRetentionDays: number;
    /** Days before long-term demotes to archive if stale (default: 90) */
    longTermRetentionDays: number;
    /** Max chunks to return per search (default: 10) */
    maxRecallChunks: number;
    /** Max tokens budget for recalled memories (default: 1500) */
    maxRecallTokens: number;
    /** Minimum messages before triggering extraction (default: 3) */
    extractionThreshold: number;
    /** Mem0 API key (optional -- enables Mem0 cloud extraction) */
    mem0ApiKey: string;
    /** Mem0 user ID for scoping memories (default: 'default') */
    mem0UserId: string;
    /** Extraction provider: 'local' or 'mem0' or 'both' (default: 'local') */
    extractionProvider: 'local' | 'mem0' | 'both';
}
export declare const DEFAULT_CONFIG: SmartMemoryConfig;
