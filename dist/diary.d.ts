import type { DiaryEntry } from './types.js';
/**
 * Write a diary entry for today.
 */
export declare function writeDiaryEntry(dataDir: string, content: string, agent?: string): DiaryEntry;
/**
 * Read diary entries.
 */
export declare function readDiary(dataDir: string, opts?: {
    date?: string;
    daysBack?: number;
    agent?: string;
}): Array<{
    date: string;
    entries: DiaryEntry[];
}>;
/**
 * List all diary dates.
 */
export declare function listDiaryDates(dataDir: string): string[];
