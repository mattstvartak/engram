// ── Memory Tiers ─────────────────────────────────────────────────────
// daily -> short-term -> long-term -> archive
// Each tier has different retention and decay characteristics.
export const DEFAULT_CONFIG = {
    dataDir: '',
    dailyRetentionDays: 2,
    shortTermRetentionDays: 14,
    longTermRetentionDays: 90,
    maxRecallChunks: 10,
    maxRecallTokens: 1500,
    extractionThreshold: 3,
    mem0ApiKey: '',
    mem0UserId: 'default',
    extractionProvider: 'local',
};
//# sourceMappingURL=types.js.map