/**
 * CONTEXT PRESSURE — self-nudge helper.
 *
 * Engram can't actually read the agent's token budget, but it can return a
 * structured checklist that reminds the agent *what* to do when context is
 * getting heavy. The agent calls this periodically (or after big tool outputs)
 * and gets back a deterministic prompt-injection telling it to write a
 * handoff note and invoke /compact.
 *
 * This exists because self-pacing compaction is a discipline problem — the
 * agent knows it should do it, but needs a loud, structured reminder.
 */
export interface PressureSignal {
    level: 'ok' | 'warm' | 'hot' | 'critical';
    /** Heuristic reason the caller gave (e.g., "long tool outputs", "many file reads") */
    reason: string;
    /** Ordered steps the agent should take before anything else */
    actionPlan: string[];
    /** Terse reminder suitable for prompt-injection */
    reminder: string;
}
export declare function assessPressure(level: PressureSignal['level'], reason?: string): PressureSignal;
