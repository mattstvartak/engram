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

const PLAN_OK = [
  'No action required. Continue working.',
  'Save any new facts, preferences, or decisions to memory_ingest as they emerge.',
];

const PLAN_WARM = [
  'Save any unsaved facts/preferences/decisions to memory_ingest now — do not batch.',
  'Update session state with current task/decisions via memory_session.',
  'Continue working but keep tool outputs lean.',
];

const PLAN_HOT = [
  'IMMEDIATELY call memory_handoff_write with a full "where we left off" snapshot.',
  'Save unsaved facts to memory_ingest.',
  'After the handoff is written, invoke /compact yourself — do not wait for the system.',
];

const PLAN_CRITICAL = [
  'STOP all other work.',
  'Call memory_handoff_write RIGHT NOW — reason: "context-pressure". Include currentTask, nextSteps, fileRefs, openQuestions.',
  'Save any unsaved facts to memory_ingest.',
  'Tell the user the context is near-full and ask permission to /compact or end the session. If no response, compact anyway — losing the handoff is worse than a surprise compact.',
];

export function assessPressure(level: PressureSignal['level'], reason = ''): PressureSignal {
  switch (level) {
    case 'ok':
      return {
        level,
        reason,
        actionPlan: PLAN_OK,
        reminder: 'Context healthy. Keep persisting memories as they emerge.',
      };
    case 'warm':
      return {
        level,
        reason,
        actionPlan: PLAN_WARM,
        reminder: 'Context warming. Persist memories now; keep outputs lean.',
      };
    case 'hot':
      return {
        level,
        reason,
        actionPlan: PLAN_HOT,
        reminder: 'Context HOT. Write handoff note, then /compact. Do not wait.',
      };
    case 'critical':
      return {
        level,
        reason,
        actionPlan: PLAN_CRITICAL,
        reminder: 'CRITICAL: window near full. Write handoff NOW or lose state.',
      };
  }
}
