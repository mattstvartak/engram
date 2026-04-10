/**
 * SESSION-STATE — Hot RAM that survives compaction.
 *
 * A fast-write scratchpad for active session state. Unlike vector memories
 * (which are extracted and searched), session state is immediately readable
 * and designed for the current working context.
 *
 * Persisted as a markdown file so it can be injected directly into
 * the agent's system prompt.
 */
export interface SessionState {
    currentTask: string;
    keyContext: string[];
    pendingActions: Array<{
        text: string;
        done: boolean;
    }>;
    recentDecisions: string[];
    updatedAt: string;
}
/**
 * Read current session state.
 */
export declare function readSessionState(dataDir: string): SessionState;
/**
 * Write session state atomically.
 * Call this BEFORE responding (WAL principle).
 */
export declare function writeSessionState(dataDir: string, state: SessionState): void;
/**
 * Update specific fields without overwriting others.
 */
export declare function updateSessionState(dataDir: string, updates: Partial<SessionState>): SessionState;
/**
 * Add a single entry to a specific field.
 */
export declare function appendToSessionState(dataDir: string, field: 'keyContext' | 'recentDecisions', value: string): void;
export declare function appendToSessionState(dataDir: string, field: 'pendingActions', value: {
    text: string;
    done: boolean;
}): void;
/**
 * Clear session state (e.g., at end of session).
 */
export declare function clearSessionState(dataDir: string): void;
