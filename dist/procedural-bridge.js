import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
const BRIDGE_PATH = join(homedir(), '.claude', 'procedural-bridge.json');
// ── File I/O ───────────────────────────────────────────────────────
export function loadBridgeFile() {
    if (!existsSync(BRIDGE_PATH)) {
        return { version: 1, lastUpdated: new Date().toISOString(), rules: [] };
    }
    try {
        return JSON.parse(readFileSync(BRIDGE_PATH, 'utf-8'));
    }
    catch {
        return { version: 1, lastUpdated: new Date().toISOString(), rules: [] };
    }
}
export function saveBridgeFile(data) {
    const dir = dirname(BRIDGE_PATH);
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    data.lastUpdated = new Date().toISOString();
    writeFileSync(BRIDGE_PATH, JSON.stringify(data, null, 2), 'utf-8');
}
// ── Export Engram Rules → Bridge ───────────────────────────────────
export async function exportRulesToBridge(storage) {
    const rules = await storage.getRules();
    const exportable = rules.filter(r => r.confidence > 0.3);
    const bridge = loadBridgeFile();
    // Keep Persona-sourced rules, replace Engram-sourced rules
    const personaRules = bridge.rules.filter(r => r.source === 'persona');
    const engramRules = exportable.map(r => ({
        id: `engram:${r.id}`,
        rule: r.rule,
        domain: r.domain,
        confidence: r.confidence,
        source: 'engram',
        sourceId: r.id,
        evidence: r.evidence.slice(-3),
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
    }));
    bridge.rules = [...personaRules, ...engramRules];
    saveBridgeFile(bridge);
    return engramRules.length;
}
// ── Import Persona Rules → Engram ──────────────────────────────────
export async function importRulesFromBridge(storage) {
    const bridge = loadBridgeFile();
    const personaRules = bridge.rules.filter(r => r.source === 'persona');
    const existing = await storage.getRules();
    let imported = 0;
    let reinforced = 0;
    let conflicts = 0;
    for (const pr of personaRules) {
        // Check if a matching Engram rule exists (word overlap)
        const matchIdx = findMatchingRule(pr.rule, existing);
        if (matchIdx >= 0) {
            const match = existing[matchIdx];
            // Check for contradiction: same subject but opposing sentiment
            if (isContradictory(pr.rule, match.rule)) {
                conflicts++;
                continue;
            }
            // Reinforce existing rule
            match.reinforcements++;
            match.confidence = Math.min(1.0, match.confidence + 0.05);
            match.evidence.push(`[persona] ${pr.evidence[0] ?? pr.rule}`);
            match.updatedAt = new Date().toISOString();
            await storage.saveRule(match);
            reinforced++;
        }
        else {
            // Create new rule with lower initial confidence (needs reinforcement)
            const newRule = {
                id: `persona-${pr.sourceId}`,
                rule: pr.rule,
                domain: mapPersonaDomain(pr.domain),
                confidence: 0.4,
                reinforcements: 0,
                contradictions: 0,
                evidence: [`[persona] ${pr.evidence[0] ?? 'Imported from Persona evolution'}`],
                createdAt: pr.createdAt,
                updatedAt: new Date().toISOString(),
            };
            await storage.saveRule(newRule);
            imported++;
        }
    }
    return { imported, reinforced, conflicts };
}
// ── Sync (bidirectional) ───────────────────────────────────────────
export async function syncBridge(storage) {
    const exported = await exportRulesToBridge(storage);
    const { imported, reinforced, conflicts } = await importRulesFromBridge(storage);
    return { exported, imported, reinforced, conflicts };
}
// ── Helpers ─────────────────────────────────────────────────────────
function findMatchingRule(newRule, existing) {
    const newWords = new Set(newRule.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    if (newWords.size < 2)
        return -1;
    for (let i = 0; i < existing.length; i++) {
        const existingWords = new Set(existing[i].rule.toLowerCase().split(/\s+/).filter(w => w.length > 3));
        let overlap = 0;
        for (const w of newWords)
            if (existingWords.has(w))
                overlap++;
        if (newWords.size > 0 && overlap / newWords.size > 0.5)
            return i;
    }
    return -1;
}
function isContradictory(a, b) {
    const aLower = a.toLowerCase();
    const bLower = b.toLowerCase();
    // Simple negation check
    const negations = ['not', 'never', "don't", 'avoid', 'stop', 'no longer'];
    const aHasNeg = negations.some(n => aLower.includes(n));
    const bHasNeg = negations.some(n => bLower.includes(n));
    // If one has negation and the other doesn't, and they share key words
    if (aHasNeg !== bHasNeg) {
        const aWords = new Set(aLower.split(/\s+/).filter(w => w.length > 4));
        const bWords = new Set(bLower.split(/\s+/).filter(w => w.length > 4));
        let overlap = 0;
        for (const w of aWords)
            if (bWords.has(w))
                overlap++;
        return overlap >= 3;
    }
    return false;
}
function mapPersonaDomain(domain) {
    const map = {
        style: 'communication',
        personality: 'general',
        skill: 'code',
        communication: 'communication',
        code: 'code',
        workflow: 'workflow',
        preference: 'preference',
    };
    return map[domain] ?? 'general';
}
//# sourceMappingURL=procedural-bridge.js.map