import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SmartMemoryConfig } from './types.js';
import { Storage } from './storage.js';
import { consolidate, type ConsolidationStats } from './consolidator.js';
import { syncBridge } from './procedural-bridge.js';
import { extractRules, normalizeScope } from './procedural.js';
import { llmExtractAndPersist } from './kg-extractor.js';
import { isLlmAvailable } from './llm.js';
import { writeDiaryEntry, listDiaryDates } from './diary.js';
import { normalizeDomain, normalizeTaxonomyValue } from './utils.js';

type SyncStats = Awaited<ReturnType<typeof syncBridge>>;

/**
 * Maintenance orchestration.
 *
 * consolidate() is the entire tier lifecycle — promotion, decay, linking,
 * merging, episodic summarization — and before this module existed its
 * only trigger was a manual memory-maintain call. Deployments where no
 * agent ever invoked that tool (most of them) accumulated thousands of
 * chunks frozen in short-term with zero procedural rules. Maintenance now
 * self-schedules: the server checks the last-run stamp at boot and runs
 * when overdue, plus an interval timer for long-lived processes.
 *
 * State lives in <dataDir>/maintenance.json:
 *   lastRunAt          — ISO stamp of the last completed run
 *   rulesBackfilledAt  — one-shot marker for the preference/correction
 *                        rule backfill (see backfillRules)
 */

export interface MaintenanceState {
  lastRunAt: string | null;
  rulesBackfilledAt: string | null;
  kgBackfilledAt: string | null;
}

export interface MaintenanceResult extends ConsolidationStats {
  bridge: SyncStats;
  rulesBackfilled: number;
  kgTriplesExtracted: number;
  diaryDigestWritten: boolean;
  taxonomyRewritten: number;
}

const STATE_FILE = 'maintenance.json';

export function readMaintenanceState(dataDir: string): MaintenanceState {
  const path = join(dataDir, STATE_FILE);
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8'));
      return {
        lastRunAt: typeof parsed?.lastRunAt === 'string' ? parsed.lastRunAt : null,
        rulesBackfilledAt: typeof parsed?.rulesBackfilledAt === 'string' ? parsed.rulesBackfilledAt : null,
        kgBackfilledAt: typeof parsed?.kgBackfilledAt === 'string' ? parsed.kgBackfilledAt : null,
      };
    } catch { /* corrupt state treated as never-run */ }
  }
  return { lastRunAt: null, rulesBackfilledAt: null, kgBackfilledAt: null };
}

function writeMaintenanceState(dataDir: string, state: MaintenanceState): void {
  writeFileSync(join(dataDir, STATE_FILE), JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function autoMaintainEnabled(): boolean {
  const v = process.env.PRZM_MEMORY_AUTO_MAINTAIN ?? process.env.ENGRAM_AUTO_MAINTAIN;
  return v !== '0' && v !== 'false';
}

export function maintainIntervalMs(): number {
  const raw = process.env.PRZM_MEMORY_MAINTAIN_INTERVAL_HOURS ?? process.env.ENGRAM_MAINTAIN_INTERVAL_HOURS;
  const hours = raw ? parseFloat(raw) : 24;
  return (Number.isFinite(hours) && hours > 0 ? hours : 24) * 3_600_000;
}

export function maintenanceOverdue(dataDir: string): boolean {
  const state = readMaintenanceState(dataDir);
  if (!state.lastRunAt) return true;
  return Date.now() - new Date(state.lastRunAt).getTime() >= maintainIntervalMs();
}

/**
 * One-shot backfill: preference/correction chunks ingested before rule
 * extraction was wired into memory-ingest never produced procedural
 * rules. Replay their content through the extractor in batches (the LLM
 * path reads 20 messages per call, so batching keeps cost bounded when a
 * key is configured; the heuristic path is free either way).
 *
 * Runs once per store. Re-running extraction over the same content on
 * every maintenance pass would re-reinforce matched rules and inflate
 * confidence, so the completion stamp is a hard gate.
 */
async function backfillRules(config: SmartMemoryConfig, storage: Storage): Promise<number> {
  const chunks = await storage.listChunks();
  // A long memory is stored as a whole parent plus child pieces. Extract from the whole: a
  // child can start mid-thought, carries no label, and extracting from both would count every
  // rule twice.
  const sources = chunks
    .filter(c => (c.type === 'preference' || c.type === 'correction') && !c.parentChunkId)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    .slice(0, 500);
  if (sources.length === 0) return 0;

  // Batches are grouped by project so a rule takes the scope of the chunk it came from. A
  // mixed batch would have to guess, and guessing "everywhere" is how a Stave copy rule ended
  // up in every session.
  // Also grouped by importance, so a rule from a 0.95 correction starts above one from a
  // passing preference instead of every rule sitting level at 0.5 after a rebuild.
  const knownScopes = new Set(chunks.map(c => normalizeScope(c.domain)).filter(Boolean));
  const groups = new Map<string, typeof sources>();
  for (const c of sources) {
    const key = `${normalizeScope(c.domain)}|${Math.round(c.importance * 10) / 10}`;
    const list = groups.get(key) ?? [];
    list.push(c);
    groups.set(key, list);
  }
  const BATCH = 20;
  for (const [key, list] of groups) {
    const [scope, imp] = key.split('|');
    const seedConfidence = 0.3 + 0.4 * Number(imp);
    for (let i = 0; i < list.length; i += BATCH) {
      const batch = list.slice(i, i + BATCH);
      try {
        await extractRules(config, storage, batch.map(c => ({ role: 'user', content: c.content })), undefined, { scope, knownScopes, seedConfidence });
      } catch { /* best-effort per batch */ }
    }
  }
  return sources.length;
}

/**
 * Throw the rules table away and derive it again from the correction and preference chunks.
 * The table is meant to be a function of those chunks and the extractor; when the extractor
 * changes, this is how the table catches up, and it is reproducible where hand-pruning is not.
 */
export async function rebuildRules(config: SmartMemoryConfig, storage: Storage): Promise<{ deleted: number; sources: number; rules: number }> {
  const old = await storage.getRules();
  for (const r of old) await storage.deleteRule(r.id);
  const state = readMaintenanceState(config.dataDir);
  state.rulesBackfilledAt = null;
  writeMaintenanceState(config.dataDir, state);
  const sources = await backfillRules(config, storage);
  state.rulesBackfilledAt = new Date().toISOString();
  writeMaintenanceState(config.dataDir, state);
  return { deleted: old.length, sources, rules: (await storage.getRules()).length };
}

/**
 * LLM knowledge-graph extraction during maintenance. The regex extractor
 * that runs per-ingest catches only simple English shapes, so this pass
 * replays chunk content through the LLM path in bounded batches:
 *   - one-shot backfill over existing long-term chunks (capped, stamped
 *     only when the LLM was actually available so it runs when a model
 *     gets configured later)
 *   - an incremental pass over chunks created since the last run
 */
const KG_BACKFILL_CAP = 600;
const KG_INCREMENTAL_CAP = 200;

async function extractKgTriples(
  config: SmartMemoryConfig,
  storage: Storage,
  state: MaintenanceState
): Promise<number> {
  if (!isLlmAvailable()) return 0;

  const chunks = await storage.listChunks();
  const eligible = chunks.filter(c => c.consolidationLevel !== -1 && c.tier !== 'scratch');

  const since = state.lastRunAt ? new Date(state.lastRunAt).getTime() : 0;
  const targets = eligible
    .filter(c => new Date(c.createdAt).getTime() >= since)
    .slice(0, KG_INCREMENTAL_CAP);

  if (!state.kgBackfilledAt) {
    const seen = new Set(targets.map(c => c.id));
    const backfill = eligible
      .filter(c => c.tier === 'long-term' && !seen.has(c.id))
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      .slice(0, KG_BACKFILL_CAP);
    targets.push(...backfill);
    state.kgBackfilledAt = new Date().toISOString();
  }
  if (targets.length === 0) return 0;

  try {
    return await llmExtractAndPersist(config, storage, targets.map(c => ({
      id: c.id,
      content: c.content,
      context: { domain: c.domain, topic: c.topic, source: c.source },
    })));
  } catch {
    return 0;
  }
}

/**
 * Rewrite stored domain/topic values to the same canonical form ingest
 * now applies: quotes/brackets/whitespace stripped, domains lowercased.
 * Conservative on purpose — case, quote, and whitespace variants only.
 * Semantically different names (elevate vs take5-dewe) are left alone.
 */
async function normalizeTaxonomyPass(storage: Storage): Promise<number> {
  const chunks = await storage.listChunks();
  let rewritten = 0;
  storage.beginBatch();
  try {
    for (const chunk of chunks) {
      const domain = normalizeDomain(chunk.domain);
      const topic = normalizeTaxonomyValue(chunk.topic);
      if (domain === (chunk.domain ?? '') && topic === (chunk.topic ?? '')) continue;
      await storage.updateChunk(chunk.id, { domain, topic });
      rewritten++;
    }
  } finally {
    await storage.flushBatch();
  }
  return rewritten;
}

/**
 * Auto-digest the day's daily-log activity into the diary when no diary
 * entry exists yet for today. Keeps the diary alive without any agent
 * remembering to call memory-diary-write.
 */
async function writeDiaryDigest(config: SmartMemoryConfig, storage: Storage): Promise<boolean> {
  const today = new Date().toISOString().split('T')[0];
  try {
    if (listDiaryDates(config.dataDir).includes(today)) return false;

    const logs = await storage.getDailyLogs(1);
    const entries = logs.find(l => l.date === today)?.entries ?? [];
    if (entries.length === 0) return false;

    const summaries = entries
      .map(e => e.summary)
      .filter(s => s && s.trim().length > 0)
      .slice(0, 12);
    const factCount = entries.reduce((n, e) => n + e.extractedFacts.length, 0);

    const lines = [
      `Auto-digest of today's memory activity: ${entries.length} ingest${entries.length === 1 ? '' : 's'}, ${factCount} extracted fact${factCount === 1 ? '' : 's'}.`,
      ...summaries.map(s => `- ${s}`),
    ];
    writeDiaryEntry(config.dataDir, lines.join('\n'), 'maintenance');
    return true;
  } catch {
    return false;
  }
}

/**
 * Full maintenance pass: consolidation, bridge sync, LLM KG extraction,
 * diary digest, and (once) the rule backfill. Shared by the
 * memory-maintain tool and the auto scheduler so both paths stay
 * identical.
 */
export async function runMaintenance(
  config: SmartMemoryConfig,
  storage: Storage
): Promise<MaintenanceResult> {
  const stats = await consolidate(storage, config);

  let bridge: SyncStats = { exported: 0, imported: 0, reinforced: 0, conflicts: 0 };
  try {
    bridge = await syncBridge(storage);
  } catch { /* bridge sync is best-effort */ }

  const state = readMaintenanceState(config.dataDir);
  let rulesBackfilled = 0;
  if (!state.rulesBackfilledAt) {
    rulesBackfilled = await backfillRules(config, storage);
    state.rulesBackfilledAt = new Date().toISOString();
  }

  const kgTriplesExtracted = await extractKgTriples(config, storage, state);
  const diaryDigestWritten = await writeDiaryDigest(config, storage);
  let taxonomyRewritten = 0;
  try {
    taxonomyRewritten = await normalizeTaxonomyPass(storage);
  } catch { /* best-effort */ }

  state.lastRunAt = new Date().toISOString();
  writeMaintenanceState(config.dataDir, state);

  return { ...stats, bridge, rulesBackfilled, kgTriplesExtracted, diaryDigestWritten, taxonomyRewritten };
}
