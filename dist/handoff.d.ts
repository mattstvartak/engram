/**
 * HANDOFF NOTES — "where we left off" lifeline for cross-session continuity.
 *
 * Unlike diary entries (free-form journal) or session-state (ephemeral scratchpad),
 * handoffs are *structured* resume-from-here snapshots written immediately before
 * context compaction or session end. If the context window fills before compaction
 * runs, the user abandons the chat — the handoff is the ONLY way to continue in
 * a fresh session without re-explaining everything.
 *
 * Schema is opinionated on purpose: a fresh agent can pick up from any field
 * without hunting through prose.
 */
export interface HandoffNote {
    /** ISO timestamp of when this handoff was written */
    timestamp: string;
    /** Optional human-friendly checkpoint name (e.g. "engram-named-checkpoints"). Allows list-and-pick resume across many saved sessions. */
    name?: string;
    /** Session or conversation identifier */
    sessionId: string | null;
    /** Why the handoff was written: compact, session-end, manual, context-pressure */
    reason: 'compact' | 'session-end' | 'manual' | 'context-pressure';
    /** One-sentence description of the active task */
    currentTask: string;
    /** What's already been completed in this session */
    completed: string[];
    /** The very next concrete action(s) to take on resume */
    nextSteps: string[];
    /** Unresolved questions, blockers, or decisions awaiting user input */
    openQuestions: string[];
    /** File paths (ideally path:line) the next agent needs to look at */
    fileRefs: string[];
    /** Key decisions made this session that shape future work */
    decisions: string[];
    /** Anything else the next agent MUST know — hidden constraints, quirks, gotchas */
    notes: string;
}
export declare function writeHandoff(dataDir: string, rawNote: Omit<HandoffNote, 'timestamp'>): HandoffNote;
export declare function readHandoff(dataDir: string, identifier?: string): HandoffNote | null;
export interface HandoffListEntry {
    stamp: string;
    timestamp: string;
    reason: string;
    currentTask: string;
    name?: string;
}
/**
 * List handoff checkpoints, newest first. Includes the optional `name` so a
 * caller can present a list-and-pick UI keyed on either stamp or name.
 */
export declare function listHandoffs(dataDir: string, limit?: number): HandoffListEntry[];
