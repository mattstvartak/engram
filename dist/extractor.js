import { randomUUID } from 'node:crypto';
import { llmComplete, embed, isLlmAvailable } from './llm.js';
import { isDuplicate } from './utils.js';
// ── LLM Extraction Prompt ───────────────────────────────────────────
const EXTRACTION_PROMPT = `You extract durable memories from conversations between a user and an AI assistant.

You will receive a condensed version of the conversation (messages may be truncated). Extract what you can from the available text.

CLASSIFY each memory into a cognitive layer:

EPISODIC -- Events tied to a specific moment. Include temporal context when available.
  "User debugged a schema migration and it took most of the session"
  "User was frustrated when the API kept returning 429 errors"

SEMANTIC -- Enduring facts that persist across conversations.
  "User prefers TypeScript over Python"
  "User's dog is named Ellie"
  "User is building a SaaS for trades businesses"

PROCEDURAL -- Rules about how the user wants things done. Patterns, preferences, corrections.
  "Always include error handling in code without being asked"
  "Show the code fix first, then explain the cause"
  "Never use em-dashes in writing"

ASSESS emotional tone of the conversation:
  frustrated -- correcting, re-asking, annoyed
  curious -- exploring, asking follow-ups
  satisfied -- approved, thanked, moved on
  neutral -- standard exchange
  excited -- enthusiastic, building something new
  confused -- needed clarification

RATE importance from 0.0 to 1.0. Be conservative:
  0.9-1.0 -- Core identity (name, primary role, major project)
  0.6-0.8 -- Strong preference or important decision
  0.4-0.5 -- Standard fact or minor preference
  0.2-0.3 -- Situational detail, might not matter later
  0.1 -- Barely worth storing
  Most memories should be 0.3-0.6. Reserve 0.8+ for things that define who the user is.

DO NOT extract:
- Temporary debugging steps or transient state
- File paths or git output (obvious from code context)
- General knowledge the user looked up
- Greetings or small talk
- Things the assistant said (only extract user-provided information)

Return a JSON array. Each item:
{
  "content": "...",
  "type": "fact"|"preference"|"decision"|"context"|"correction",
  "cognitiveLayer": "episodic"|"semantic"|"procedural",
  "tags": ["topic1", "topic2"],
  "sentiment": "frustrated"|"curious"|"satisfied"|"neutral"|"excited"|"confused",
  "importance": 0.0-1.0
}

Return [] if nothing worth remembering. Return ONLY valid JSON. No markdown fences.`;
// ── Reconsolidation Prompt ──────────────────────────────────────────
const RECONSOLIDATION_PROMPT = `You are updating a memory based on new context. The original memory was formed earlier. It has just been recalled during a conversation and was useful.

ORIGINAL MEMORY:
{{MEMORY_CONTENT}}

MEMORY TYPE: {{TYPE}} | LAYER: {{COGNITIVE_LAYER}}

CURRENT CONVERSATION CONTEXT (last few messages):
{{RECENT_MESSAGES}}

Rewrite the memory to be more accurate, specific, and useful given this new context. Rules:
- Keep the core fact/preference/rule intact
- Add specificity or nuance from the current context if relevant
- If the current context reveals the memory is partially outdated, update it
- If nothing meaningful can be added, return the original text unchanged
- Keep it concise -- one to two sentences max
- Do NOT add information the user didn't provide
- Do NOT change the cognitive layer or fundamental nature of the memory

Return ONLY the updated memory text. No JSON, no explanation.`;
// ── Extract Function ────────────────────────────────────────────────
export async function extractFromConversation(config, storage, messages, conversationId, opts) {
    const userAssistant = messages.filter(m => m.role === 'user' || m.role === 'assistant');
    if (!opts?.forceExtract && userAssistant.length < config.extractionThreshold)
        return [];
    if (userAssistant.length === 0)
        return [];
    // Choose extraction strategy based on LLM availability
    const raw = isLlmAvailable()
        ? await llmExtract(config, userAssistant)
        : heuristicExtract(userAssistant);
    const validTypes = ['fact', 'preference', 'decision', 'context', 'correction'];
    const validLayers = ['episodic', 'semantic', 'procedural'];
    const existing = await storage.listChunks({ excludeTiers: ['archive'] });
    const chunks = [];
    for (const r of raw) {
        if (!r.content || !validTypes.includes(r.type))
            continue;
        if (isDuplicate(r.content, existing))
            continue;
        const chunk = {
            id: randomUUID(),
            tier: 'short-term',
            content: r.content,
            type: r.type,
            cognitiveLayer: validLayers.includes(r.cognitiveLayer) ? r.cognitiveLayer : 'semantic',
            tags: Array.isArray(r.tags) ? r.tags : [],
            domain: r.domain ?? '',
            topic: r.topic ?? '',
            source: conversationId,
            importance: typeof r.importance === 'number' ? Math.min(1, Math.max(0, r.importance)) : 0.5,
            sentiment: r.sentiment ?? 'neutral',
            createdAt: new Date().toISOString(),
            lastRecalledAt: null,
            recallCount: 0,
            relatedMemories: [],
            recallOutcomes: [],
        };
        // Generate embedding (optional -- search falls back to keyword)
        try {
            chunk.embedding = await embed(config, chunk.content);
        }
        catch {
            // Embeddings are optional
        }
        await storage.saveChunk(chunk);
        chunks.push(chunk);
    }
    // Append to daily log
    if (chunks.length > 0) {
        const date = new Date().toISOString().split('T')[0];
        await storage.appendDailyEntry(date, {
            timestamp: new Date().toISOString(),
            conversationId,
            summary: userAssistant.map(m => m.content).join(' ').slice(0, 200),
            extractedFacts: chunks.map(c => c.content),
        });
    }
    return chunks;
}
// ── LLM-powered extraction ──────────────────────────────────────────
async function llmExtract(config, messages) {
    const condensed = messages
        .map(m => `${m.role}: ${m.content.slice(0, 500)}`)
        .join('\n\n');
    if (condensed.length < 50)
        return [];
    const text = await llmComplete(config, EXTRACTION_PROMPT, condensed, { maxTokens: 1000, temperature: 0 });
    return parseJsonArray(text);
}
const SENTENCE_SPLIT = /(?<=[.!?])\s+|(?<=\n)/;
// Patterns scored per sentence. Each returns a match or null.
const HEURISTIC_PATTERNS = [
    // Identity / role -- high importance
    { test: /\b(?:i am|i'm|my name is|my role|i work (?:at|as|for|on)|my job|my team|i've been)\b/i, type: 'fact', layer: 'semantic', importance: 0.8 },
    // Strong preferences
    { test: /\b(?:i (?:always|never) |i (?:really )?(?:prefer|hate|love|can't stand))\b/i, type: 'preference', layer: 'procedural', importance: 0.7 },
    // Mild preferences
    { test: /\b(?:i (?:like|want|prefer|rather|favor)|my favorite)\b/i, type: 'preference', layer: 'semantic', importance: 0.5 },
    // Corrections (user correcting the assistant)
    { test: /\b(?:no[,.]+ (?:use|do|that's)|wrong|incorrect|that's not|don't (?:do|use|add)|stop (?:doing|using|adding)|instead[,.]+ use|actually[,.]+ i)\b/i, type: 'correction', layer: 'procedural', importance: 0.7, sentiment: 'frustrated' },
    // Decisions
    { test: /\b(?:decided|going (?:to go|with)|chose|let's (?:use|go|switch)|switching to|picked|we'll use|i'll use)\b/i, type: 'decision', layer: 'semantic', importance: 0.6 },
    // Rules / directives
    { test: /\b(?:always |never |make sure|every time|whenever you|from now on|do not |rule:|important:)\b/i, type: 'preference', layer: 'procedural', importance: 0.7 },
    // Current context
    { test: /\b(?:working on|building|trying to|my project|currently|right now|this week|today i)\b/i, type: 'context', layer: 'episodic', importance: 0.4 },
    // Tools / tech stack
    { test: /\b(?:we use|our stack|we're using|built with|deployed (?:on|to|with)|running on)\b/i, type: 'fact', layer: 'semantic', importance: 0.5 },
];
function heuristicExtract(messages) {
    const results = [];
    const seen = new Set();
    for (const msg of messages) {
        if (msg.role !== 'user')
            continue;
        const sentences = msg.content
            .split(SENTENCE_SPLIT)
            .map(s => s.trim())
            .filter(s => s.length > 15 && s.length < 500);
        for (const sentence of sentences) {
            for (const pattern of HEURISTIC_PATTERNS) {
                if (!pattern.test.test(sentence))
                    continue;
                // Normalize for dedup
                const key = sentence.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
                if (seen.has(key))
                    break;
                seen.add(key);
                results.push({
                    content: sentence,
                    type: pattern.type,
                    cognitiveLayer: pattern.layer,
                    importance: pattern.importance,
                    sentiment: pattern.sentiment ?? 'neutral',
                    tags: extractTags(sentence),
                    domain: '',
                    topic: '',
                });
                break; // One match per sentence (use highest-priority pattern)
            }
        }
    }
    return results;
}
function extractTags(text) {
    const tags = [];
    const lower = text.toLowerCase();
    // Tech terms
    const techTerms = ['typescript', 'javascript', 'python', 'rust', 'go', 'react', 'vue',
        'node', 'deno', 'bun', 'docker', 'kubernetes', 'aws', 'gcp', 'azure', 'vercel',
        'postgres', 'sqlite', 'redis', 'mongodb', 'graphql', 'rest', 'api', 'cli',
        'nextjs', 'next.js', 'svelte', 'tailwind', 'css', 'html'];
    for (const term of techTerms) {
        if (lower.includes(term))
            tags.push(term);
    }
    return tags.slice(0, 5);
}
// ── Reconsolidation ─────────────────────────────────────────────────
export async function reconsolidate(config, storage, chunk, recentMessages) {
    // Reconsolidation requires LLM -- skip if unavailable
    if (!isLlmAvailable())
        return;
    if (chunk.lastRecalledAt) {
        const elapsed = Date.now() - new Date(chunk.lastRecalledAt).getTime();
        if (elapsed < 24 * 60 * 60 * 1000)
            return;
    }
    const context = recentMessages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .slice(-3)
        .map(m => `${m.role}: ${m.content.slice(0, 400)}`)
        .join('\n');
    if (context.length < 20)
        return;
    const prompt = RECONSOLIDATION_PROMPT
        .replace('{{MEMORY_CONTENT}}', chunk.content)
        .replace('{{TYPE}}', chunk.type)
        .replace('{{COGNITIVE_LAYER}}', chunk.cognitiveLayer)
        .replace('{{RECENT_MESSAGES}}', context);
    const updated = await llmComplete(config, prompt, 'Update the memory based on the context above.', {
        maxTokens: 200,
        temperature: 0,
    });
    const trimmed = updated.trim();
    if (trimmed.length > 0 && trimmed !== chunk.content && trimmed.length < chunk.content.length * 3) {
        let newEmbedding;
        try {
            newEmbedding = await embed(config, trimmed);
        }
        catch {
            // Keep old embedding
        }
        await storage.updateChunk(chunk.id, {
            content: trimmed,
            ...(newEmbedding ? { embedding: newEmbedding } : {}),
        });
    }
}
// ── Helpers ─────────────────────────────────────────────────────────
function parseJsonArray(text) {
    const match = text.match(/\[[\s\S]*?\]/) ?? text.match(/\[[\s\S]*\]/);
    if (!match)
        return [];
    try {
        return JSON.parse(match[0]);
    }
    catch {
        const greedy = text.match(/\[[\s\S]*\]/);
        if (greedy) {
            try {
                return JSON.parse(greedy[0]);
            }
            catch { /* noop */ }
        }
        return [];
    }
}
//# sourceMappingURL=extractor.js.map