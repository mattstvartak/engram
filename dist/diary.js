import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
/**
 * Agent diary -- persistent cross-session journal.
 *
 * Each day gets a markdown file: diary/YYYY-MM-DD.md
 * Entries are appended throughout the day with timestamps.
 * Human-readable and easy to grep.
 *
 * Unlike session state (ephemeral scratchpad), the diary builds
 * institutional knowledge about what happened over time.
 */
function diaryDir(dataDir) {
    return join(dataDir, 'diary');
}
function diaryPath(dataDir, date) {
    return join(diaryDir(dataDir), `${date}.md`);
}
function today() {
    return new Date().toISOString().split('T')[0];
}
function now() {
    return new Date().toISOString().split('T')[1].split('.')[0];
}
/**
 * Write a diary entry for today.
 */
export function writeDiaryEntry(dataDir, content, agent = 'claude') {
    const dir = diaryDir(dataDir);
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    const date = today();
    const time = now();
    const path = diaryPath(dataDir, date);
    const entry = { date, time, content: content.trim(), agent };
    // Append to the day's file
    let existing = '';
    if (existsSync(path)) {
        existing = readFileSync(path, 'utf-8');
    }
    else {
        existing = `# Diary -- ${date}\n\n`;
    }
    const entryText = `## ${time} (${agent})\n\n${entry.content}\n\n`;
    writeFileSync(path, existing + entryText, 'utf-8');
    return entry;
}
/**
 * Read diary entries.
 */
export function readDiary(dataDir, opts) {
    const dir = diaryDir(dataDir);
    if (!existsSync(dir))
        return [];
    const dates = [];
    if (opts?.date) {
        dates.push(opts.date);
    }
    else {
        const daysBack = opts?.daysBack ?? 7;
        const files = readdirSync(dir)
            .filter(f => f.endsWith('.md'))
            .map(f => f.replace('.md', ''))
            .sort()
            .reverse();
        const cutoff = new Date(Date.now() - daysBack * 86_400_000).toISOString().split('T')[0];
        for (const f of files) {
            if (f >= cutoff)
                dates.push(f);
        }
    }
    const results = [];
    for (const date of dates) {
        const path = diaryPath(dataDir, date);
        if (!existsSync(path))
            continue;
        const text = readFileSync(path, 'utf-8');
        const entries = parseDiaryFile(date, text);
        const filtered = opts?.agent
            ? entries.filter(e => e.agent === opts.agent)
            : entries;
        if (filtered.length > 0) {
            results.push({ date, entries: filtered });
        }
    }
    return results;
}
/**
 * List all diary dates.
 */
export function listDiaryDates(dataDir) {
    const dir = diaryDir(dataDir);
    if (!existsSync(dir))
        return [];
    return readdirSync(dir)
        .filter(f => f.endsWith('.md'))
        .map(f => f.replace('.md', ''))
        .sort()
        .reverse();
}
// ── Parser ──────────────────────────────────────────────────────────
function parseDiaryFile(date, text) {
    const entries = [];
    const blocks = text.split(/^## /m).filter(b => b.trim());
    for (const block of blocks) {
        // Match: "HH:MM:SS (agent)\n\ncontent"
        const headerMatch = block.match(/^(\d{2}:\d{2}:\d{2})\s*\(([^)]+)\)\s*\n+([\s\S]*)/);
        if (headerMatch) {
            entries.push({
                date,
                time: headerMatch[1],
                agent: headerMatch[2].trim(),
                content: headerMatch[3].trim(),
            });
        }
    }
    return entries;
}
//# sourceMappingURL=diary.js.map