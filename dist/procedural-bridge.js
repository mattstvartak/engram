import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
/**
 * Read at call time, not module load, so a test can point it at a temp dir. Left at module
 * load it read the real file under $HOME from inside the test suite.
 */
function bridgePath() {
    return process.env.PRZM_MEMORY_BRIDGE_PATH ?? process.env.ENGRAM_BRIDGE_PATH ?? join(homedir(), '.claude', 'procedural-bridge.json');
}
// ── File I/O ───────────────────────────────────────────────────────
export function loadBridgeFile() {
    if (!existsSync(bridgePath())) {
        return { version: 1, lastUpdated: new Date().toISOString(), rules: [] };
    }
    try {
        return JSON.parse(readFileSync(bridgePath(), 'utf-8'));
    }
    catch {
        return { version: 1, lastUpdated: new Date().toISOString(), rules: [] };
    }
}
export function saveBridgeFile(data) {
    const dir = dirname(bridgePath());
    // 0700 owner-only (defensive). Bridge file mediates with przm Voice.
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true, mode: 0o700 });
    data.lastUpdated = new Date().toISOString();
    writeFileSync(bridgePath(), JSON.stringify(data, null, 2), 'utf-8');
}
// ── Export przm Memory Rules → Bridge ──────────────────────────────
export async function exportRulesToBridge(storage) {
    const rules = await storage.getRules();
    const exportable = rules.filter(r => r.confidence > 0.3);
    const bridge = loadBridgeFile();
    // Keep Voice-sourced rules, replace Memory-sourced rules
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
// ── Import Voice Rules → przm Memory ───────────────────────────────
export async function importRulesFromBridge(storage) {
    const bridge = loadBridgeFile();
    const personaRules = bridge.rules.filter(r => r.source === 'persona');
    const existing = await storage.getRules();
    let imported = 0;
    let reinforced = 0;
    let conflicts = 0;
    for (const pr of personaRules) {
        // Check if a matching przm Memory rule exists (word overlap)
        const matchIdx = findMatchingRule(pr.rule, existing);
        if (matchIdx >= 0) {
            const match = existing[matchIdx];
            // Check for contradiction: same subject but opposing sentiment
            if (isContradictory(pr.rule, match.rule)) {
                conflicts++;
                continue;
            }
            // Reinforce only on new evidence. This ran on every maintenance pass and bumped the same
            // unchanged Voice rule by 0.05 each time, which is unbounded inflation from a file nobody
            // touched.
            if (pr.updatedAt && match.updatedAt && pr.updatedAt <= match.updatedAt)
                continue;
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
                scope: '',
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
    // Negation-based detection
    const negations = ['not', 'never', "don't", 'avoid', 'stop', 'no longer', "won't", 'without'];
    const aHasNeg = negations.some(n => aLower.includes(n));
    const bHasNeg = negations.some(n => bLower.includes(n));
    // If one has negation and the other doesn't, check for semantic overlap
    if (aHasNeg !== bHasNeg) {
        const aWords = new Set(aLower.split(/\s+/).filter(w => w.length > 3));
        const bWords = new Set(bLower.split(/\s+/).filter(w => w.length > 3));
        let overlap = 0;
        for (const w of aWords)
            if (bWords.has(w))
                overlap++;
        // Lower threshold: 2 shared words with negation inversion = likely contradiction
        if (overlap >= 2)
            return true;
    }
    // Value contradiction: same predicate, different object
    // e.g. "prefers TypeScript" vs "prefers Python"
    const predicates = ['prefers?', 'uses?', 'wants?', 'chooses?', 'switched to', 'moved to'];
    for (const pred of predicates) {
        const regex = new RegExp(`\\b${pred}\\s+(\\S+)`, 'i');
        const aMatch = aLower.match(regex);
        const bMatch = bLower.match(regex);
        if (aMatch && bMatch && aMatch[1] !== bMatch[1]) {
            // Same predicate but different value — check subject overlap
            const aSubj = aLower.split(/\s+/).slice(0, 3);
            const bSubj = bLower.split(/\s+/).slice(0, 3);
            const subjOverlap = aSubj.some(w => bSubj.includes(w) && w.length > 3);
            if (subjOverlap)
                return true;
        }
    }
    // Antonym detection for common pairs
    const antonymPairs = [
        ['always', 'never'], ['enable', 'disable'], ['allow', 'block'],
        ['verbose', 'terse'], ['include', 'exclude'], ['before', 'after'],
        ['more', 'less'], ['increase', 'decrease'], ['add', 'remove'],
    ];
    for (const [pos, neg] of antonymPairs) {
        if ((aLower.includes(pos) && bLower.includes(neg)) ||
            (aLower.includes(neg) && bLower.includes(pos))) {
            // Check they're about the same thing (word overlap)
            const aWords = new Set(aLower.split(/\s+/).filter(w => w.length > 3 && w !== pos && w !== neg));
            const bWords = new Set(bLower.split(/\s+/).filter(w => w.length > 3 && w !== pos && w !== neg));
            let overlap = 0;
            for (const w of aWords)
                if (bWords.has(w))
                    overlap++;
            if (overlap >= 2)
                return true;
        }
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