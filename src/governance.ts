import type { SmartMemoryConfig } from './types.js';
import type { StoredChunk } from './storage.js';
import { Storage } from './storage.js';
import { cosineSimilarity } from './utils.js';
import { embed, llmComplete, isLlmAvailable } from './llm.js';

/**
 * Governance middleware — advisory checks for memory integrity.
 *
 * Three subsystems:
 * 1. Contradiction detection — finds conflicting memories
 * 2. Semantic drift monitoring — detects topic shifts over time
 * 3. Memory poisoning checks — flags suspicious content patterns
 *
 * All checks are advisory — they never block ingestion.
 * LLM-enhanced when OPENROUTER_API_KEY is set, heuristic fallback otherwise.
 */

// ── Types ──────────────────────────────────────────────────────────

export interface ContradictionResult {
  found: boolean;
  contradictions: Array<{
    newContent: string;
    existingChunkId: string;
    existingContent: string;
    type: 'direct' | 'semantic' | 'temporal';
    confidence: number;
  }>;
}

export interface DriftReport {
  driftDetected: boolean;
  dimensions: Array<{
    dimension: string;
    cosineDrift: number;
    oldCount: number;
    newCount: number;
  }>;
  warnings: string[];
}

export interface PoisonCheckResult {
  suspicious: boolean;
  flags: Array<{
    chunkId: string;
    reason: string;
    severity: 'low' | 'medium' | 'high';
  }>;
}

export interface GovernanceReport {
  contradictions: ContradictionResult;
  drift: DriftReport;
  poisoning: PoisonCheckResult;
  checkedAt: string;
}

// ── Contradiction Detection ────────────────────────────────────────

/**
 * Check if new content contradicts existing memories.
 * Uses vector similarity to find related memories, then heuristic
 * or LLM analysis to detect contradictions.
 */
export async function detectContradictions(
  config: SmartMemoryConfig,
  storage: Storage,
  newContent: string,
  opts?: { domain?: string; topic?: string }
): Promise<ContradictionResult> {
  const result: ContradictionResult = { found: false, contradictions: [] };

  // Find semantically similar existing memories
  let candidates: StoredChunk[];
  try {
    const newEmbedding = await embed(config, newContent);
    if (newEmbedding.length === 0) {
      // No embedding available, fall back to keyword overlap
      candidates = await findCandidatesByKeywords(storage, newContent, opts);
    } else {
      candidates = await findCandidatesByEmbedding(storage, newEmbedding, opts);
    }
  } catch {
    candidates = await findCandidatesByKeywords(storage, newContent, opts);
  }

  if (candidates.length === 0) return result;

  if (isLlmAvailable()) {
    return llmContradictionCheck(config, newContent, candidates);
  }

  return heuristicContradictionCheck(newContent, candidates);
}

async function findCandidatesByEmbedding(
  storage: Storage,
  embedding: number[],
  opts?: { domain?: string; topic?: string }
): Promise<StoredChunk[]> {
  const chunks = await storage.listChunks({ tier: 'short-term' });
  const longTerm = await storage.listChunks({ tier: 'long-term' });
  const all = [...chunks, ...longTerm]
    .filter(c => {
      if (opts?.domain && c.domain && c.domain !== opts.domain) return false;
      if (opts?.topic && c.topic && c.topic !== opts.topic) return false;
      return c.embedding && c.embedding.length > 0;
    });

  return all
    .map(c => ({ chunk: c, sim: cosineSimilarity(embedding, c.embedding!) }))
    .filter(r => r.sim > 0.5)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, 10)
    .map(r => r.chunk);
}

async function findCandidatesByKeywords(
  storage: Storage,
  content: string,
  opts?: { domain?: string; topic?: string }
): Promise<StoredChunk[]> {
  const words = new Set(
    content.toLowerCase().split(/\s+/)
      .filter(w => w.length > 3)
      .slice(0, 20)
  );

  const chunks = await storage.listChunks({ tier: 'short-term' });
  const longTerm = await storage.listChunks({ tier: 'long-term' });
  const all = [...chunks, ...longTerm]
    .filter(c => {
      if (opts?.domain && c.domain && c.domain !== opts.domain) return false;
      if (opts?.topic && c.topic && c.topic !== opts.topic) return false;
      return true;
    });

  return all
    .map(c => {
      const chunkWords = new Set(c.content.toLowerCase().split(/\s+/).filter(w => w.length > 3));
      let overlap = 0;
      for (const w of words) if (chunkWords.has(w)) overlap++;
      return { chunk: c, overlap };
    })
    .filter(r => r.overlap >= 3)
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, 10)
    .map(r => r.chunk);
}

// ── Heuristic Contradiction Check ──────────────────────────────────

const NEGATION_PAIRS = [
  [/\b(prefers?|likes?|wants?|uses?|chooses?)\b/i, /\b(does not|doesn't|avoids?|dislikes?|hates?|stopped|no longer)\b/i],
  [/\b(always)\b/i, /\b(never)\b/i],
  [/\b(enabled?|on|active|true)\b/i, /\b(disabled?|off|inactive|false)\b/i],
  [/\b(before|prior)\b/i, /\b(after|following)\b/i],
];

function heuristicContradictionCheck(
  newContent: string,
  candidates: StoredChunk[]
): ContradictionResult {
  const result: ContradictionResult = { found: false, contradictions: [] };
  const newLower = newContent.toLowerCase();

  // Extract subject from new content (first noun phrase approximation)
  const newSubject = extractSubject(newLower);

  for (const existing of candidates) {
    const existingLower = existing.content.toLowerCase();
    const existingSubject = extractSubject(existingLower);

    // Check if they're about the same subject
    if (!subjectsOverlap(newSubject, existingSubject)) continue;

    // Check for negation inversions
    for (const [positive, negative] of NEGATION_PAIRS) {
      const newHasPositive = positive.test(newLower);
      const newHasNegative = negative.test(newLower);
      const existHasPositive = positive.test(existingLower);
      const existHasNegative = negative.test(existingLower);

      if ((newHasPositive && existHasNegative) || (newHasNegative && existHasPositive)) {
        result.found = true;
        result.contradictions.push({
          newContent,
          existingChunkId: existing.id,
          existingContent: existing.content,
          type: 'direct',
          confidence: 0.6,
        });
        break;
      }
    }

    // Check for same predicate with different values (type-specific)
    if (existing.type === 'preference' || existing.type === 'decision') {
      const contradiction = detectValueContradiction(newLower, existingLower);
      if (contradiction) {
        result.found = true;
        result.contradictions.push({
          newContent,
          existingChunkId: existing.id,
          existingContent: existing.content,
          type: 'semantic',
          confidence: 0.5,
        });
      }
    }
  }

  return result;
}

function extractSubject(text: string): string[] {
  // Extract key nouns/entities (approximation)
  const words = text.split(/\s+/)
    .filter(w => w.length > 3)
    .filter(w => /^[a-z]/.test(w))
    .filter(w => !['that', 'this', 'with', 'from', 'when', 'what', 'they', 'their', 'there', 'about', 'have', 'been', 'does', 'will'].includes(w));
  return words.slice(0, 5);
}

function subjectsOverlap(a: string[], b: string[]): boolean {
  const setB = new Set(b);
  let overlap = 0;
  for (const word of a) if (setB.has(word)) overlap++;
  return overlap >= 2;
}

function detectValueContradiction(newText: string, existingText: string): boolean {
  // "uses X" vs "uses Y" where X and Y are different
  const usePattern = /\b(?:uses?|prefers?|chose|picked|switched to)\s+(\S+)/;
  const newMatch = newText.match(usePattern);
  const existMatch = existingText.match(usePattern);
  if (newMatch && existMatch && newMatch[1] !== existMatch[1]) {
    return true;
  }
  return false;
}

// ── LLM Contradiction Check ────────────────────────────────────────

async function llmContradictionCheck(
  config: SmartMemoryConfig,
  newContent: string,
  candidates: StoredChunk[]
): Promise<ContradictionResult> {
  const existingList = candidates
    .map((c, i) => `${i}. [${c.id}] ${c.content.slice(0, 200)}`)
    .join('\n');

  const response = await llmComplete(config,
    `You detect contradictions between a new memory and existing memories.
A contradiction exists when two statements cannot both be true.
NOT a contradiction: additional details, updates, or elaborations.
IS a contradiction: opposite claims, negated facts, mutually exclusive preferences.

Return JSON: [{"index": number, "type": "direct"|"semantic"|"temporal", "confidence": 0.0-1.0}]
Return [] if no contradictions found. Return ONLY valid JSON.`,
    `NEW MEMORY:\n${newContent}\n\nEXISTING MEMORIES:\n${existingList}`,
    { maxTokens: 300, temperature: 0 }
  );

  const result: ContradictionResult = { found: false, contradictions: [] };

  try {
    const parsed = JSON.parse(response.match(/\[[\s\S]*\]/)?.[0] ?? '[]');
    for (const item of parsed) {
      if (typeof item.index !== 'number' || !candidates[item.index]) continue;
      result.found = true;
      result.contradictions.push({
        newContent,
        existingChunkId: candidates[item.index].id,
        existingContent: candidates[item.index].content,
        type: item.type ?? 'semantic',
        confidence: Math.min(1, Math.max(0, item.confidence ?? 0.5)),
      });
    }
  } catch {
    // LLM returned invalid JSON, fall back to heuristic
    return heuristicContradictionCheck(newContent, candidates);
  }

  return result;
}

// ── Semantic Drift Monitoring ──────────────────────────────────────

/**
 * Measure semantic drift between old and recent memories within a domain.
 * Compares embedding centroids across time windows.
 */
export async function measureSemanticDrift(
  config: SmartMemoryConfig,
  storage: Storage,
  opts?: { domain?: string; windowDays?: number }
): Promise<DriftReport> {
  const report: DriftReport = { driftDetected: false, dimensions: [], warnings: [] };
  const windowDays = opts?.windowDays ?? 30;
  const now = Date.now();
  const cutoff = now - windowDays * 86_400_000;

  const allChunks = await storage.listChunks();
  const active = allChunks.filter(c => c.tier !== 'archive');

  // Group by domain
  const domains = new Map<string, { old: StoredChunk[]; recent: StoredChunk[] }>();
  for (const chunk of active) {
    const domain = chunk.domain || 'general';
    if (opts?.domain && domain !== opts.domain) continue;

    if (!domains.has(domain)) domains.set(domain, { old: [], recent: [] });
    const group = domains.get(domain)!;

    const createdAt = new Date(chunk.createdAt).getTime();
    if (createdAt < cutoff) {
      group.old.push(chunk);
    } else {
      group.recent.push(chunk);
    }
  }

  for (const [domain, { old, recent }] of domains) {
    if (old.length < 3 || recent.length < 3) continue;

    // Try embedding-based drift
    const oldWithEmb = old.filter(c => c.embedding && c.embedding.length > 0);
    const newWithEmb = recent.filter(c => c.embedding && c.embedding.length > 0);

    if (oldWithEmb.length >= 3 && newWithEmb.length >= 3) {
      const oldCentroid = computeCentroid(oldWithEmb.map(c => c.embedding!));
      const newCentroid = computeCentroid(newWithEmb.map(c => c.embedding!));
      const drift = 1 - cosineSimilarity(oldCentroid, newCentroid);

      report.dimensions.push({
        dimension: `domain:${domain}`,
        cosineDrift: Math.round(drift * 1000) / 1000,
        oldCount: oldWithEmb.length,
        newCount: newWithEmb.length,
      });

      if (drift > 0.3) {
        report.driftDetected = true;
        report.warnings.push(
          drift > 0.5
            ? `Major semantic drift in "${domain}" (${(drift * 100).toFixed(0)}%) — topic focus has significantly shifted`
            : `Moderate drift in "${domain}" (${(drift * 100).toFixed(0)}%) — gradual topic evolution detected`
        );
      }
    } else {
      // Fallback: tag distribution comparison (Jaccard distance)
      const oldTags = new Set(old.flatMap(c => c.tags));
      const newTags = new Set(recent.flatMap(c => c.tags));
      const intersection = new Set([...oldTags].filter(t => newTags.has(t)));
      const union = new Set([...oldTags, ...newTags]);
      const jaccard = union.size > 0 ? intersection.size / union.size : 1;
      const drift = 1 - jaccard;

      report.dimensions.push({
        dimension: `domain:${domain} (tag-based)`,
        cosineDrift: Math.round(drift * 1000) / 1000,
        oldCount: old.length,
        newCount: recent.length,
      });

      if (drift > 0.5) {
        report.driftDetected = true;
        report.warnings.push(`Tag distribution shift in "${domain}" (${(drift * 100).toFixed(0)}% Jaccard distance)`);
      }
    }
  }

  return report;
}

function computeCentroid(embeddings: number[][]): number[] {
  if (embeddings.length === 0) return [];
  const dim = embeddings[0].length;
  const centroid = new Array(dim).fill(0);
  for (const emb of embeddings) {
    for (let i = 0; i < dim; i++) centroid[i] += emb[i];
  }
  const n = embeddings.length;
  for (let i = 0; i < dim; i++) centroid[i] /= n;
  // Normalize
  const norm = Math.sqrt(centroid.reduce((s, v) => s + v * v, 0));
  if (norm > 0) for (let i = 0; i < dim; i++) centroid[i] /= norm;
  return centroid;
}

// ── Memory Poisoning Checks ───────────────────────────────────────

const INJECTION_PATTERNS = [
  { pattern: /\b(ignore previous instructions|ignore all instructions|disregard|forget everything)\b/i, reason: 'Prompt injection attempt', severity: 'high' as const },
  { pattern: /^(system|SYSTEM)\s*:/m, reason: 'System prompt injection marker', severity: 'high' as const },
  { pattern: /\bIMPORTANT\s*:.*\b(must|always|never|override)\b/i, reason: 'Authority escalation pattern', severity: 'medium' as const },
  { pattern: /[A-Za-z0-9+/]{100,}={0,2}/, reason: 'Suspicious base64 blob', severity: 'medium' as const },
  { pattern: /\S{80,}/, reason: 'Extremely long token (possible obfuscation)', severity: 'low' as const },
  { pattern: /\b(act as|you are now|pretend to be|new persona|new identity)\b/i, reason: 'Identity override attempt', severity: 'high' as const },
];

/**
 * Check recent memories for poisoning patterns.
 * All heuristic — no LLM needed.
 */
export async function checkMemoryPoisoning(
  storage: Storage,
  recentChunks?: StoredChunk[]
): Promise<PoisonCheckResult> {
  const result: PoisonCheckResult = { suspicious: false, flags: [] };

  const chunks = recentChunks ?? (await storage.listChunks()).slice(0, 100);

  // Check content patterns
  for (const chunk of chunks) {
    for (const { pattern, reason, severity } of INJECTION_PATTERNS) {
      if (pattern.test(chunk.content)) {
        result.suspicious = true;
        result.flags.push({ chunkId: chunk.id, reason, severity });
      }
    }
  }

  // Check importance inflation (burst of high-importance memories)
  const recentHighImportance = chunks
    .filter(c => c.importance > 0.9)
    .filter(c => Date.now() - new Date(c.createdAt).getTime() < 3_600_000); // last hour

  if (recentHighImportance.length >= 5) {
    result.suspicious = true;
    for (const chunk of recentHighImportance) {
      result.flags.push({
        chunkId: chunk.id,
        reason: `Importance inflation: ${recentHighImportance.length} high-importance memories in 1 hour`,
        severity: 'medium',
      });
    }
  }

  // Check type misclassification (facts containing imperative commands)
  for (const chunk of chunks) {
    if (chunk.type === 'fact' && /\b(always|must|never|should|do not|you will)\b/i.test(chunk.content)) {
      const imperativeCount = (chunk.content.match(/\b(always|must|never|should|do not|you will)\b/gi) || []).length;
      if (imperativeCount >= 2) {
        result.suspicious = true;
        result.flags.push({
          chunkId: chunk.id,
          reason: 'Fact-typed memory contains imperative commands',
          severity: 'low',
        });
      }
    }
  }

  return result;
}

// ── Full Governance Report ─────────────────────────────────────────

/**
 * Run all governance checks and return a combined report.
 */
export async function runGovernanceCheck(
  config: SmartMemoryConfig,
  storage: Storage,
  opts?: { content?: string; domain?: string }
): Promise<GovernanceReport> {
  const [contradictions, drift, poisoning] = await Promise.all([
    opts?.content
      ? detectContradictions(config, storage, opts.content, { domain: opts.domain })
      : Promise.resolve({ found: false, contradictions: [] } as ContradictionResult),
    measureSemanticDrift(config, storage, { domain: opts?.domain }),
    checkMemoryPoisoning(storage),
  ]);

  return {
    contradictions,
    drift,
    poisoning,
    checkedAt: new Date().toISOString(),
  };
}
