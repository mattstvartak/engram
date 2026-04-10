import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

/**
 * SESSION-STATE — Hot RAM that survives compaction.
 *
 * A fast-write scratchpad for active session state. Unlike vector memories
 * (which are extracted and searched), session state is immediately readable
 * and designed for the current working context.
 *
 * Persisted as a markdown file so it can be injected directly into
 * OpenClaw's workspace bootstrap.
 */

export interface SessionState {
  currentTask: string;
  keyContext: string[];
  pendingActions: Array<{ text: string; done: boolean }>;
  recentDecisions: string[];
  updatedAt: string;
}

const EMPTY_STATE: SessionState = {
  currentTask: '',
  keyContext: [],
  pendingActions: [],
  recentDecisions: [],
  updatedAt: new Date().toISOString(),
};

function statePath(dataDir: string): string {
  return join(dataDir, 'SESSION-STATE.md');
}

/**
 * Read current session state.
 */
export function readSessionState(dataDir: string): SessionState {
  const path = statePath(dataDir);
  if (!existsSync(path)) return { ...EMPTY_STATE };

  const text = readFileSync(path, 'utf-8');
  return parseSessionState(text);
}

/**
 * Write session state atomically.
 * Call this BEFORE responding (WAL principle).
 */
export function writeSessionState(dataDir: string, state: SessionState): void {
  const dir = dirname(statePath(dataDir));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  state.updatedAt = new Date().toISOString();
  const md = formatSessionState(state);
  writeFileSync(statePath(dataDir), md, 'utf-8');
}

/**
 * Update specific fields without overwriting others.
 */
export function updateSessionState(
  dataDir: string,
  updates: Partial<SessionState>
): SessionState {
  const current = readSessionState(dataDir);
  const merged: SessionState = {
    currentTask: updates.currentTask ?? current.currentTask,
    keyContext: updates.keyContext ?? current.keyContext,
    pendingActions: updates.pendingActions ?? current.pendingActions,
    recentDecisions: updates.recentDecisions ?? current.recentDecisions,
    updatedAt: new Date().toISOString(),
  };
  writeSessionState(dataDir, merged);
  return merged;
}

/**
 * Add a single entry to a specific field.
 */
export function appendToSessionState(
  dataDir: string,
  field: 'keyContext' | 'recentDecisions',
  value: string
): void;
export function appendToSessionState(
  dataDir: string,
  field: 'pendingActions',
  value: { text: string; done: boolean }
): void;
export function appendToSessionState(
  dataDir: string,
  field: 'keyContext' | 'recentDecisions' | 'pendingActions',
  value: string | { text: string; done: boolean }
): void {
  const current = readSessionState(dataDir);

  if (field === 'pendingActions') {
    current.pendingActions.push(value as { text: string; done: boolean });
  } else {
    current[field].push(value as string);
    // Keep lists bounded
    if (current[field].length > 20) {
      current[field] = current[field].slice(-20);
    }
  }

  writeSessionState(dataDir, current);
}

/**
 * Clear session state (e.g., at end of session).
 */
export function clearSessionState(dataDir: string): void {
  writeSessionState(dataDir, { ...EMPTY_STATE });
}

// ── Markdown Format ──────────────────────────────────────────────────

function formatSessionState(state: SessionState): string {
  const lines: string[] = [
    '# SESSION-STATE — Active Working Memory',
    '',
    '> This file is hot RAM — survives compaction, restarts, distractions.',
    '',
    '## Current Task',
    state.currentTask || '_No active task_',
    '',
  ];

  if (state.keyContext.length > 0) {
    lines.push('## Key Context');
    for (const ctx of state.keyContext) lines.push(`- ${ctx}`);
    lines.push('');
  }

  if (state.pendingActions.length > 0) {
    lines.push('## Pending Actions');
    for (const action of state.pendingActions) {
      lines.push(`- [${action.done ? 'x' : ' '}] ${action.text}`);
    }
    lines.push('');
  }

  if (state.recentDecisions.length > 0) {
    lines.push('## Recent Decisions');
    for (const dec of state.recentDecisions) lines.push(`- ${dec}`);
    lines.push('');
  }

  lines.push('---');
  lines.push(`*Last updated: ${state.updatedAt}*`);

  return lines.join('\n');
}

function parseSessionState(text: string): SessionState {
  const state: SessionState = { ...EMPTY_STATE };

  // Parse Current Task
  const taskMatch = text.match(/## Current Task\n(.+)/);
  if (taskMatch && !taskMatch[1].startsWith('_No')) {
    state.currentTask = taskMatch[1].trim();
  }

  // Parse Key Context
  const ctxMatch = text.match(/## Key Context\n([\s\S]*?)(?=\n##|\n---)/);
  if (ctxMatch) {
    state.keyContext = ctxMatch[1]
      .split('\n')
      .filter(l => l.startsWith('- '))
      .map(l => l.slice(2).trim());
  }

  // Parse Pending Actions
  const actionsMatch = text.match(/## Pending Actions\n([\s\S]*?)(?=\n##|\n---)/);
  if (actionsMatch) {
    state.pendingActions = actionsMatch[1]
      .split('\n')
      .filter(l => l.match(/^- \[[ x]\]/))
      .map(l => ({
        done: l.includes('[x]'),
        text: l.replace(/^- \[[ x]\] /, '').trim(),
      }));
  }

  // Parse Recent Decisions
  const decMatch = text.match(/## Recent Decisions\n([\s\S]*?)(?=\n##|\n---)/);
  if (decMatch) {
    state.recentDecisions = decMatch[1]
      .split('\n')
      .filter(l => l.startsWith('- '))
      .map(l => l.slice(2).trim());
  }

  // Parse timestamp
  const tsMatch = text.match(/\*Last updated: (.+)\*/);
  if (tsMatch) state.updatedAt = tsMatch[1];

  return state;
}
