import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
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
/**
 * Some MCP clients bleed the closing tag of one parameter and the opening of the next into a
 * string value. Seen on a real handoff: currentTask ended with "</currentTask>" and the whole
 * "completed" array as text, while "completed" itself arrived empty. Strip it from every string
 * before the note is written.
 */
function cleanText(value) {
    return value.replace(/<\/[a-zA-Z]+>[\s\S]*$/, '').replace(/<parameter name="[^"]*">[^\n]*/g, '').trim();
}
function cleanNote(note) {
    const out = { ...note };
    for (const [k, v] of Object.entries(out)) {
        if (typeof v === 'string')
            out[k] = cleanText(v);
        else if (Array.isArray(v))
            out[k] = v.map(x => (typeof x === 'string' ? cleanText(x) : x)).filter(x => x !== '');
    }
    return out;
}
export function writeHandoff(dataDir, rawNote) {
    const note = cleanNote(rawNote);
    const dir = handoffDir(dataDir);
    // 0700 = owner-only access. Handoffs contain "where we left off"
    // session context -- file refs, decisions, open questions. Not
    // world-readable on shared systems.
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true, mode: 0o700 });
    const timestamp = new Date().toISOString();
    const full = { ...note, timestamp };
    // Stamps are second-resolution; two handoffs written within the same
    // second (a hook checkpoint racing an agent handoff) would silently
    // overwrite each other. Suffix until the name is free.
    let stamp = stampFilename();
    for (let n = 2; existsSync(handoffJsonPath(dataDir, stamp)); n++) {
        stamp = `${stampFilename()}-${n}`;
    }
    // Atomic write for the JSON+MD pair. Two non-atomic writeFileSync
    // calls in a row could leave a JSON file with no markdown sibling
    // (or vice versa) on crash, breaking the pairing readHandoff
    // relies on. Stage both as .tmp first, then rename both -- minimizes
    // the crash window to the gap between two consecutive renameSync
    // calls (sub-millisecond). True cross-file atomicity isn't
    // expressible in POSIX; this is the best practical approximation.
    const jsonPath = handoffJsonPath(dataDir, stamp);
    const mdPath = handoffMdPath(dataDir, stamp);
    writeFileSync(`${jsonPath}.tmp`, JSON.stringify(full, null, 2), 'utf-8');
    writeFileSync(`${mdPath}.tmp`, formatHandoffMarkdown(full), 'utf-8');
    renameSync(`${jsonPath}.tmp`, jsonPath);
    renameSync(`${mdPath}.tmp`, mdPath);
    return full;
}
/**
 * Read the most recent handoff, or a specific one by stamp or name.
 *
 * Identifier resolution order:
 *   1. No identifier → latest timestamped handoff
 *   2. Identifier matches stamp regex → load by stamp
 *   3. Otherwise → scan handoff JSONs for `name` field match (newest match wins)
 */
// Timestamped handoff filenames look like "2026-04-22_14-32-05-123Z" (what
// stampFilename() produces). The rolling `session-checkpoint.json` written
// by engram_stop_hook.sh does NOT match this shape, so it won't shadow real
// handoffs when readHandoff() picks the latest.
//
// SECURITY: anchored at end with optional millisecond+timezone suffix.
// An earlier version was unanchored, which allowed a `stamp` like
// "2026-01-01_00-00-00/../../.pyre/credentials" to match and then be
// joined into the file path -- arbitrary `.json` file read.
const STAMP_RE = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(-\d+Z?)?$/;
// Defense-in-depth path-safety check on any user-provided identifier
// before it touches the filesystem. Even with STAMP_RE anchored, a
// future change that loosens the regex shouldn't reopen the traversal.
function isSafeHandoffIdentifier(identifier) {
    if (!identifier)
        return false;
    if (identifier.length > 200)
        return false;
    if (identifier.includes('/') || identifier.includes('\\'))
        return false;
    if (identifier.includes('..'))
        return false;
    if (identifier.includes('\0'))
        return false;
    return true;
}
export function readHandoff(dataDir, identifier) {
    const dir = handoffDir(dataDir);
    if (!existsSync(dir))
        return null;
    if (!identifier) {
        const allJson = readdirSync(dir).filter(f => f.endsWith('.json'));
        const timestamped = allJson.filter(f => STAMP_RE.test(f.replace(/\.json$/, ''))).sort().reverse();
        const pick = timestamped[0] ?? allJson.sort().reverse()[0];
        if (!pick)
            return null;
        return loadHandoffFile(handoffJsonPath(dataDir, pick.replace(/\.json$/, '')));
    }
    if (!isSafeHandoffIdentifier(identifier))
        return null;
    if (STAMP_RE.test(identifier)) {
        return loadHandoffFile(handoffJsonPath(dataDir, identifier));
    }
    // Name lookup — scan newest first, return first hit.
    const stamps = readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace(/\.json$/, ''))
        .sort()
        .reverse();
    for (const stamp of stamps) {
        const note = loadHandoffFile(handoffJsonPath(dataDir, stamp));
        if (note?.name === identifier)
            return note;
    }
    return null;
}
function loadHandoffFile(path) {
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
 * List handoff checkpoints, newest first. Includes the optional `name` so a
 * caller can present a list-and-pick UI keyed on either stamp or name.
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
                ...(note.name ? { name: note.name } : {}),
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
        `# Handoff — ${note.name ?? note.timestamp}`,
        '',
        note.name ? `**Name:** ${note.name}` : '',
        `**Reason:** ${note.reason}`,
        `**Timestamp:** ${note.timestamp}`,
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