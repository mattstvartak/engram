import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
function handoffDir(dataDir) {
    return join(dataDir, 'handoffs');
}
function stampFilename() {
    // YYYY-MM-DD_HH-MM-SS — safe for filenames, chronologically sortable
    return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').split('-').slice(0, 6).join('-');
}
function handoffJsonPath(dataDir, stamp) {
    return join(handoffDir(dataDir), `${stamp}.json`);
}
function handoffMdPath(dataDir, stamp) {
    return join(handoffDir(dataDir), `${stamp}.md`);
}
/**
 * Write a handoff note. Persists BOTH JSON (machine-readable) and markdown (human-readable).
 */
export function writeHandoff(dataDir, note) {
    const dir = handoffDir(dataDir);
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    const timestamp = new Date().toISOString();
    const full = { ...note, timestamp };
    const stamp = stampFilename();
    writeFileSync(handoffJsonPath(dataDir, stamp), JSON.stringify(full, null, 2), 'utf-8');
    writeFileSync(handoffMdPath(dataDir, stamp), formatHandoffMarkdown(full), 'utf-8');
    return full;
}
/**
 * Read the most recent handoff, or a specific one by stamp.
 */
export function readHandoff(dataDir, stamp) {
    const dir = handoffDir(dataDir);
    if (!existsSync(dir))
        return null;
    let targetStamp = stamp;
    if (!targetStamp) {
        const files = readdirSync(dir)
            .filter(f => f.endsWith('.json'))
            .sort()
            .reverse();
        if (files.length === 0)
            return null;
        targetStamp = files[0].replace(/\.json$/, '');
    }
    const path = handoffJsonPath(dataDir, targetStamp);
    if (!existsSync(path))
        return null;
    try {
        return JSON.parse(readFileSync(path, 'utf-8'));
    }
    catch {
        return null;
    }
}
/**
 * List handoff stamps, newest first.
 */
export function listHandoffs(dataDir, limit = 10) {
    const dir = handoffDir(dataDir);
    if (!existsSync(dir))
        return [];
    const stamps = readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace(/\.json$/, ''))
        .sort()
        .reverse()
        .slice(0, limit);
    const results = [];
    for (const stamp of stamps) {
        try {
            const note = JSON.parse(readFileSync(handoffJsonPath(dataDir, stamp), 'utf-8'));
            results.push({
                stamp,
                timestamp: note.timestamp,
                reason: note.reason,
                currentTask: note.currentTask,
            });
        }
        catch {
            // Skip malformed
        }
    }
    return results;
}
function formatHandoffMarkdown(note) {
    const lines = [
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
//# sourceMappingURL=handoff.js.map