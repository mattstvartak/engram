import type { SmartMemoryConfig, ProceduralRule } from './types.js';
import { Storage } from './storage.js';
import { llmComplete, isLlmAvailable } from './llm.js';
import { splitSentences } from './sentences.js';

// ── LLM Extraction Prompt ───────────────────────────────────────────

const PROCEDURAL_EXTRACTION_PROMPT = `You analyze conversations between a user and their AI assistant to extract PROCEDURAL RULES about how this specific user wants things done.

Look for implicit and explicit signals:
- Code style: what the user includes, excludes, or corrects in code
- Communication: length, tone, format, words to avoid
- Workflow: when to act vs ask, when to be thorough vs brief
- Recurring corrections: if the user keeps fixing the same thing, that IS a rule
- Direct instructions: "always do X", "never do Y", "I prefer Z"

IMPORTANT: Extract rules about what the USER wants, not what the assistant did. If the assistant used em-dashes and the user didn't correct it, that's NOT a rule. If the user said "don't use em-dashes", that IS a rule.

A rule is about HOW the user works, not WHAT to build. A feature request, a product decision, a bug report or a fact about a codebase is not a rule, even when it is phrased firmly. "Make the list virtualized" is a task. "Any list that can grow must be virtualized" is a rule.

CONVERSATION:
{{CONVERSATION}}

USER REACTION SIGNALS (these indicate user approval, frustration, corrections, etc.):
{{SIGNALS}}

EXISTING RULES (numbered -- use the number as ruleIndex when reinforcing or contradicting):
{{EXISTING_RULES}}

For each insight, output one of:
- "new" -- a rule not captured by any existing rule
- "reinforce" -- this conversation provides evidence an existing rule is correct
- "contradict" -- this conversation provides evidence an existing rule is wrong or outdated

Return a JSON array:
[{
  "rule": "Clear, specific, actionable rule",
  "domain": "code"|"communication"|"workflow"|"preference"|"general",
  "action": "new"|"reinforce"|"contradict",
  "ruleIndex": null for new rules, or the number of the existing rule,
  "evidence": "What happened in the conversation that supports this"
}]

Rules should be specific. Bad: "User likes clean code." Good: "Always add explicit return types to TypeScript functions."

If no procedural insights exist in this conversation, return [].
Return ONLY valid JSON. No markdown fences.`;

// ── Extract Rules from Conversation ─────────────────────────────────

export interface ExtractOptions {
  /** Project slug the source belongs to; empty or absent means the rule applies everywhere. */
  scope?: string;
  /** Projects the store knows about, so a rule whose label names one can be scoped to it. */
  knownScopes?: Iterable<string>;
  /** Starting confidence for new rules; a rule from a 0.95-importance correction should not start level with one from a passing note. */
  seedConfidence?: number;
}

/**
 * Domains that mean "about how I work" rather than "about this project". A rule ingested under
 * one of these applies everywhere; anything else is taken as a project slug.
 */
const GLOBAL_DOMAINS = new Set(['', 'global', 'general', 'workflow', 'communication', 'code', 'preference', 'machine', 'personal', 'orchestration', 'tooling']);

export function normalizeScope(domain: string | undefined | null): string {
  const d = (domain ?? '').trim().toLowerCase();
  return GLOBAL_DOMAINS.has(d) ? '' : d;
}

export async function extractRules(
  config: SmartMemoryConfig,
  storage: Storage,
  messages: Array<{ role: string; content: string }>,
  signals?: Array<{ type: string; confidence: number }>,
  opts: ExtractOptions = {}
): Promise<void> {
  const existing = await storage.getRules();
  const scope = normalizeScope(opts.scope);

  const results = isLlmAvailable()
    ? await llmExtractRules(config, messages, signals, existing)
    : heuristicExtractRules(messages, existing);

  for (const r of results) {
    if (!r.rule || !r.action) continue;

    if (r.action === 'new') {
      const labelled = !scope && r.label && opts.knownScopes ? scopeFromLabel(String(r.label), opts.knownScopes) : '';
      const rule: ProceduralRule = {
        id: `rule-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        rule: r.rule,
        domain: r.domain ?? 'general',
        scope: scope || labelled,
        confidence: Math.min(1, Math.max(0.2, opts.seedConfidence ?? 0.5)),
        reinforcements: 0,
        contradictions: 0,
        evidence: [r.evidence ?? ''],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await storage.saveRule(rule);
    } else if (r.action === 'reinforce' && typeof r.ruleIndex === 'number') {
      const rule = existing[r.ruleIndex];
      if (rule) {
        rule.reinforcements++;
        rule.confidence = Math.min(1.0, rule.confidence + 0.1);
        rule.evidence.push(r.evidence ?? '');
        rule.updatedAt = new Date().toISOString();
        await storage.saveRule(rule);
      }
    } else if (r.action === 'contradict' && typeof r.ruleIndex === 'number') {
      const rule = existing[r.ruleIndex];
      if (rule) {
        rule.contradictions++;
        rule.confidence = Math.max(0.0, rule.confidence - 0.2);
        rule.evidence.push(`CONTRADICTED: ${r.evidence ?? ''}`);
        rule.updatedAt = new Date().toISOString();
        if (rule.confidence <= 0) {
          await storage.deleteRule(rule.id);
        } else {
          await storage.saveRule(rule);
        }
      }
    }
  }
}

// ── LLM-powered rule extraction ─────────────────────────────────────

async function llmExtractRules(
  config: SmartMemoryConfig,
  messages: Array<{ role: string; content: string }>,
  signals: Array<{ type: string; confidence: number }> | undefined,
  existing: ProceduralRule[]
): Promise<Array<Record<string, any>>> {
  const conversation = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-20)
    .map(m => `${m.role}: ${m.content.slice(0, 300)}`)
    .join('\n');

  const signalText = signals?.map(s => `${s.type} (${s.confidence.toFixed(2)})`).join(', ') || 'none';
  const existingText = existing.length > 0
    ? existing.map((r, i) => `${i}. [${r.domain}] ${r.rule} (confidence: ${r.confidence.toFixed(2)})`).join('\n')
    : 'No existing rules.';

  const prompt = PROCEDURAL_EXTRACTION_PROMPT
    .replace('{{CONVERSATION}}', conversation)
    .replace('{{SIGNALS}}', signalText)
    .replace('{{EXISTING_RULES}}', existingText);

  const text = await llmComplete(config, prompt, 'Extract procedural rules from this conversation.', {
    maxTokens: 800,
    temperature: 0,
  });

  return parseJsonArray(text);
}

// ── Heuristic rule extraction (no API key needed) ───────────────
//
// The old version fired on any sentence containing "always" or "never", so narrative like "the
// fix was never half-applied" and "corpse_fx.gd is never saved" became standing rules, and a
// long memory split into sentences became half a dozen of them. A rule has to read as a
// directive: it starts with one, after an optional label ("Rule from Matt:") and an optional
// scoping clause ("In the DB7001 workflow, ..."). Narrative, first-person accounts and facts do
// not start that way.

// A label is any short prefix that ends in a colon and holds no sentence punctuation: "Rule from
// Matt (2026-08-19):", "Stave copy rule:", "ATTRIBUTION RULE (universal):", "Real lesson:". What
// follows it has to be the directive.
const LABEL = /^[^.!?:\n]{2,120}:\s*/;
const ENUM = /^(?:\(\d+\)|\d+[.)])\s*/;
const QUOTE = /^["'“‘]+/;
const SCOPING = /^(?:(?:in|for|on|when|during|inside|within|across)\b[^,:]{2,70},\s*)/i;
const DIRECTIVE = /^(?:always|never|do\s+not|don'?t|stop|avoid|prefer|use|keep|make|remember|be\s+sure|only|from\s+now\s+on|going\s+forward|in\s+the\s+future|treat|write|run|check|verify|ask|commit|log|report|rebase|close|shut\s+down|no\s+\w|put|leave|match|estimate|default|act|answer|deploy|ship|work|add|include|omit|skip|call|name|say|tell|send|mark|transition|wait|read|open|test|measure|state|label|replace|require|allow|ensure|(?:we\s+)?(?:need\s+to|must|should)|be)\b/i;
const PREFERENCE = /^(?:(?:i|matt|the\s+user|he|she|they|\w+)\s+)?prefers?\b/i;
// Assistant narration about what it did, as opposed to a user telling it what to do. "when I ask
// a question" is an instruction; "I proposed three fixes" is a story.
const NARRATIVE = /\bI\s+(?:proposed|moved|went|dismissed|told|found|stopped|said|did|was|had|launched|ran|made|assumed|thought|left|missed|broke)\b|\bI'?ve\b|\bI'd\b|\bturned\s+out\b|\bbecause\s+I\b|\bwas\s+never\b|\bwere\s+never\b|\bnever\s+(?:worked|made|saw|ran)\b/;

/**
 * The directive in a sentence, with its label, enumeration and quote marks stripped, or null when
 * the sentence is not one. Exported so the gate can be tested on its own.
 */
function startsAsDirective(t: string): boolean {
  const body = t.replace(SCOPING, '');
  return DIRECTIVE.test(body) || PREFERENCE.test(body);
}

export interface SplitDirective {
  /** The labels stripped off the front, joined; empty when there were none. */
  label: string;
  directive: string;
}

/**
 * The directive in a sentence and the labels that were in front of it, or null when the sentence
 * is not one. Labels matter because they often name the project a rule belongs to.
 */
export function splitDirective(sentence: string): SplitDirective | null {
  let t = sentence.trim();
  const labels: string[] = [];
  for (let i = 0; i < 3; i++) {
    t = t.replace(ENUM, '').replace(QUOTE, '').trim();
    // A directive can contain a colon of its own ("Do not probe for helpers first: X is the
    // path"). Only strip a label when what we have does not already read as a directive.
    if (startsAsDirective(t)) break;
    const m = t.match(LABEL);
    if (!m) break;
    labels.push(m[0]);
    t = t.slice(m[0].length).replace(QUOTE, '').trim();
  }
  if (!startsAsDirective(t)) return null;
  if (NARRATIVE.test(t)) return null;
  const directive = t.replace(/\s+/g, ' ').replace(/[;,:\s]+$/, '');
  if (directive.length < 20 || directive.length > 400) return null;
  // A memory the chunker cut mid-sentence ends in an open bracket or a dangling abbreviation.
  // A rule minted from that would be a fragment forever.
  const opens = (directive.match(/\(/g) ?? []).length;
  const closes = (directive.match(/\)/g) ?? []).length;
  if (opens > closes || /\((?:e\.g|i\.e)\.?$/i.test(directive)) return null;
  return { label: labels.join(' ').trim(), directive };
}

export function directiveFrom(sentence: string): string | null {
  return splitDirective(sentence)?.directive ?? null;
}

/**
 * The project a rule belongs to, read off its label when the memory itself carried no domain.
 * "Stave-admin git/deploy workflow rule (Matt set this):" names stave; the longest known slug
 * that appears wins, so "elevate-pryzm" beats "elevate".
 */
export function scopeFromLabel(label: string, knownScopes: Iterable<string>): string {
  const l = label.toLowerCase();
  let best = '';
  for (const slug of knownScopes) {
    const k = slug.toLowerCase();
    if (k.length >= 4 && l.includes(k) && k.length > best.length) best = k;
  }
  return best;
}

/**
 * Split a message into sentences without breaking inside backticks or after "e.g.", "i.e.",
 * "etc." and "vs.". Semicolons count as a break: a correction often chains two directives.
 */
export function sentencesOf(content: string): string[] {
  return splitSentences(content, { semicolons: true, newlines: true }).filter(x => x.length > 10 && x.length < 400);
}

function inferDomain(rule: string): ProceduralRule['domain'] {
  const r = rule.toLowerCase();
  if (/^(?:\w+\s+)?prefers?\b/.test(r)) return 'preference';
  if (/\b(?:commit|branch|deploy|rebase|merge|release|push|pull request|pr\b|ticket|jira|stage|prod)/.test(r)) return 'workflow';
  if (/\b(?:comment|function|variable|naming|type|import|refactor|test|code|component|css|html)/.test(r)) return 'code';
  if (/\b(?:tone|wording|copy|say|write|answer|question|reply|message|email|doc|docs|em dash|emoji)/.test(r)) return 'communication';
  return 'general';
}

function heuristicExtractRules(
  messages: Array<{ role: string; content: string }>,
  existing: ProceduralRule[]
): Array<Record<string, any>> {
  const results: Array<Record<string, any>> = [];
  const seen = new Set<string>();

  for (const msg of messages) {
    if (msg.role !== 'user') continue;

    // A label on the first sentence names the whole memory: "Stave-admin workflow rule: do X.
    // Never Y." scopes Y to stave as well, so the last label seen carries forward.
    let carriedLabel = '';
    for (const sentence of sentencesOf(msg.content)) {
      const split = splitDirective(sentence);
      if (!split) continue;
      if (split.label) carriedLabel = split.label;
      const rule = split.directive;

      const key = ruleWords(rule).size ? [...ruleWords(rule)].sort().join(' ') : rule.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const reinforceIdx = findMatchingRule(rule, existing);
      if (reinforceIdx >= 0) {
        results.push({
          rule: existing[reinforceIdx].rule,
          domain: existing[reinforceIdx].domain,
          action: 'reinforce',
          ruleIndex: reinforceIdx,
          evidence: sentence.slice(0, 200),
        });
      } else {
        results.push({ rule, domain: inferDomain(rule), action: 'new', ruleIndex: null, evidence: sentence.slice(0, 200), label: split.label || carriedLabel });
      }
    }
  }

  return results;
}

// ── Matching restatements to existing rules ─────────────────────
//
// The old check wanted half of a new rule's words to appear in an existing one, over raw
// tokens. Rules are quote-heavy and dated, so restatements almost never cleared it and the
// table filled with three copies of "close subagents when they finish". Compare content
// words only, and accept either strong overlap or the shorter rule sitting mostly inside
// the longer one.

const RULE_STOP = new Set(['matt', 'rule', 'rules', 'always', 'never', 'the', 'and', 'for', 'that', 'this', 'with', 'from', 'when', 'into', 'about', 'have', 'been', 'were', 'was', 'not', 'are', 'his', 'her', 'they', 'them', 'you', 'your', 'will', 'after', 'before', 'any', 'all', 'use', 'using', 'set', 'make', 'sure', 'should', 'must', 'then', 'than', 'also', 'only', 'just', 'over', 'more', 'some', 'such', 'while', 'where', 'which', 'what', 'who', 'does', 'did', 'has', 'had', 'its', 'our', 'out', 'off', 'per', 'via', 'too', 'very', 'ever', 'each', 'every', 'here', 'there', 'thing', 'things', 'said', 'says']);

function stem(w: string): string {
  return w.replace(/(?:ies|es|s)$/, '').replace(/(?:ing|ed)$/, '');
}

export function ruleWords(text: string): Set<string> {
  const cleaned = text
    .toLowerCase()
    .replace(/\(?\b\d{4}-\d{2}-\d{2}\b\)?/g, ' ')
    .replace(/["'`“”‘’]/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ');
  return new Set(cleaned.split(/\s+/).filter(w => w.length > 3 && !RULE_STOP.has(w)).map(stem).filter(w => w.length > 2));
}

/**
 * Containment catches a short rule restated inside a longer one; the bar relaxes a little for
 * rules with more content words, where three shared words out of five is not chance. Jaccard
 * catches two long rules that mostly overlap. Semantic restatements with different vocabulary
 * are the LLM path's job, not this one's.
 */
export function ruleSimilarity(a: string, b: string): number {
  // Compare the directives, not their labels: "Reinforced rule from Matt (said twice):" and a
  // project slug in the label share nothing with the rule and only dilute the overlap.
  const wa = ruleWords(directiveFrom(a) ?? a);
  const wb = ruleWords(directiveFrom(b) ?? b);
  const min = Math.min(wa.size, wb.size);
  if (min < 3) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  const containment = inter / min;
  const jaccard = inter / (wa.size + wb.size - inter);
  const bar = min >= 5 ? 0.6 : 0.7;
  return Math.max(containment >= bar ? containment : 0, jaccard >= 0.4 ? jaccard : 0);
}

export function findMatchingRule(newRule: string, existing: ProceduralRule[]): number {
  let best = -1;
  let bestScore = 0;
  for (let i = 0; i < existing.length; i++) {
    const score = ruleSimilarity(newRule, existing[i].rule);
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return bestScore > 0 ? best : -1;
}

// ── Format Rules for System Prompt ──────────────────────────────────

export async function formatRulesForPrompt(storage: Storage, scope?: string): Promise<string> {
  const here = normalizeScope(scope);
  const rules = (await storage.getRules())
    .filter(r => r.confidence > 0.3)
    .filter(r => scope === undefined || !r.scope || r.scope === here);
  if (rules.length === 0) return '';

  return `\n--- PROCEDURAL RULES ---\n${rules.map(r => `- [${r.domain}] ${r.rule}`).join('\n')}\n`;
}

// ── Helpers ─────────────────────────────────────────────────────────

function parseJsonArray(text: string): Array<Record<string, any>> {
  const match = text.match(/\[[\s\S]*?\]/) ?? text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    return JSON.parse(match[0]);
  } catch {
    const greedy = text.match(/\[[\s\S]*\]/);
    if (greedy) {
      try { return JSON.parse(greedy[0]); } catch { /* noop */ }
    }
    return [];
  }
}
