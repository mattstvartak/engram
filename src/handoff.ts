import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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

function handoffDir(dataDir: string): string {
  return join(dataDir, 'handoffs');
}

function stampFilename(): string {
  // YYYY-MM-DD_HH-MM-SS — safe for filenames, chronologically sortable
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').split('-').slice(0, 6).join('-');
}

function handoffJsonPath(dataDir: string, stamp: string): string {
  return join(handoffDir(dataDir), `${stamp}.json`);
}

function handoffMdPath(dataDir: string, stamp: string): string {
  return join(handoffDir(dataDir), `${stamp}.md`);
}

/**
 * Write a handoff note. Persists BOTH JSON (machine-readable) and markdown (human-readable).
 */
export function writeHandoff(dataDir: string, note: Omit<HandoffNote, 'timestamp'>): HandoffNote {
  const dir = handoffDir(dataDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const timestamp = new Date().toISOString();
  const full: HandoffNote = { ...note, timestamp };
  const stamp = stampFilename();

  writeFileSync(handoffJsonPath(dataDir, stamp), JSON.stringify(full, null, 2), 'utf-8');
  writeFileSync(handoffMdPath(dataDir, stamp), formatHandoffMarkdown(full), 'utf-8');

  return full;
}

/**
 * Read the most recent handoff, or a specific one by stamp.
 */
// Timestamped handoff filenames look like "2026-04-22_14-32-05-123Z" (what
// stampFilename() produces). The rolling `session-checkpoint.json` written
// by engram_stop_hook.sh does NOT match this shape, so it won't shadow real
// handoffs when readHandoff() picks the latest.
const STAMP_RE = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}/;

export function readHandoff(dataDir: string, stamp?: string): HandoffNote | null {
  const dir = handoffDir(dataDir);
  if (!existsSync(dir)) return null;

  let targetStamp = stamp;
  if (!targetStamp) {
    const allJson = readdirSync(dir).filter(f => f.endsWith('.json'));
    const timestamped = allJson.filter(f => STAMP_RE.test(f)).sort().reverse();
    // Prefer an explicitly-written, timestamped handoff; fall back to any
    // other .json (e.g. the rolling session checkpoint) only if none exist.
    const pick = timestamped[0] ?? allJson.sort().reverse()[0];
    if (!pick) return null;
    targetStamp = pick.replace(/\.json$/, '');
  }

  const path = handoffJsonPath(dataDir, targetStamp);
  if (!existsSync(path)) return null;

  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as HandoffNote;
  } catch {
    return null;
  }
}

/**
 * List handoff stamps, newest first.
 */
export function listHandoffs(dataDir: string, limit = 10): Array<{ stamp: string; timestamp: string; reason: string; currentTask: string }> {
  const dir = handoffDir(dataDir);
  if (!existsSync(dir)) return [];

  const stamps = readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace(/\.json$/, ''))
    .sort()
    .reverse()
    .slice(0, limit);

  const results: Array<{ stamp: string; timestamp: string; reason: string; currentTask: string }> = [];
  for (const stamp of stamps) {
    try {
      const note = JSON.parse(readFileSync(handoffJsonPath(dataDir, stamp), 'utf-8')) as HandoffNote;
      results.push({
        stamp,
        timestamp: note.timestamp,
        reason: note.reason,
        currentTask: note.currentTask,
      });
    } catch {
      // Skip malformed
    }
  }
  return results;
}

function formatHandoffMarkdown(note: HandoffNote): string {
  const lines: string[] = [
    `# Handoff — ${note.timestamp}`,
    '',
    `**Reason:** ${note.reason}`,
    note.sessionId ? `**Session:** ${note.sessionId}` : '',
    '',
    '## Current Task',
    note.currentTask || '_unspecified_',
    '',
  ];

  if (note.completed.length) {
    lines.push('## Completed', ...note.completed.map(c => `- ${c}`), '');
  }
  if (note.nextSteps.length) {
    lines.push('## Next Steps', ...note.nextSteps.map(s => `- ${s}`), '');
  }
  if (note.openQuestions.length) {
    lines.push('## Open Questions', ...note.openQuestions.map(q => `- ${q}`), '');
  }
  if (note.fileRefs.length) {
    lines.push('## File Refs', ...note.fileRefs.map(f => `- ${f}`), '');
  }
  if (note.decisions.length) {
    lines.push('## Decisions', ...note.decisions.map(d => `- ${d}`), '');
  }
  if (note.notes.trim()) {
    lines.push('## Notes', note.notes.trim(), '');
  }

  return lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
}
