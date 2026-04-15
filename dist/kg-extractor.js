import { addTriple } from './knowledge-graph.js';
/**
 * Relationship patterns ordered by specificity (most specific first).
 * Each pattern produces a (subject, predicate, object) triple.
 */
const PATTERNS = [
    // ── Identity / Role ───────────────────────────────────────────
    // "Matt is a software engineer" / "I am a data scientist"
    {
        regex: /\b(I|i)\s+am\s+(?:a|an)\s+(.+?)(?:\.|,|$)/i,
        extract: (m, ctx) => ({
            subject: 'user',
            predicate: 'role',
            object: m[2].trim(),
            confidence: 0.5,
        }),
    },
    // "Matt is the founder of OneNomad"
    {
        regex: /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+is\s+(?:the\s+)?(\w+)\s+(?:of|at)\s+(.+?)(?:\.|,|$)/,
        extract: (m) => ({
            subject: m[1].trim(),
            predicate: m[2].toLowerCase(),
            object: m[3].trim(),
            confidence: 0.4,
        }),
    },
    // ── Works on / Works at ───────────────────────────────────────
    // "I work at Acme" / "Matt works at Google"
    {
        regex: /\b(?:I|i|[A-Z][a-z]+)\s+works?\s+(?:at|for)\s+(.+?)(?:\.|,|$)/i,
        extract: (m) => {
            const subject = m[0].match(/^(I|i)\b/) ? 'user' : m[0].split(/\s+works?\b/i)[0].trim();
            return {
                subject,
                predicate: 'works-at',
                object: m[1].trim(),
                confidence: 0.5,
            };
        },
    },
    // "working on ProjectX" / "I'm working on the auth system"
    {
        regex: /\b(?:working|worked)\s+on\s+(.+?)(?:\.|,|$)/i,
        extract: (m, ctx) => ({
            subject: ctx.domain || 'user',
            predicate: 'works-on',
            object: cleanObject(m[1]),
            confidence: 0.4,
        }),
    },
    // ── Uses / Built with ─────────────────────────────────────────
    // "FieldLedgr uses Stripe" — subject must be a proper noun (capitalized, not common words)
    {
        regex: /\b([A-Z][a-z]+[\w-]*(?:\s+[A-Z][\w-]*)*)\s+(?:uses?|is\s+built\s+with|is\s+using|runs?\s+on)\s+(.+?)(?:\.|,|$)/,
        extract: (m) => {
            const subject = m[1].trim();
            // Skip common sentence starters that aren't proper nouns
            if (/^(The|This|That|It|There|Here|Some|Any|Each|Every|Most|Just|Also|But|And|However|Decided|Currently)$/i.test(subject))
                return null;
            return {
                subject,
                predicate: 'uses',
                object: cleanObject(m[2]),
                confidence: 0.45,
            };
        },
    },
    // "we use X" / "I use Vim"
    {
        regex: /\b(?:we|I|i)\s+(?:use|using|switched\s+to|moved\s+to|migrated\s+to)\s+(.+?)(?:\s+(?:for|in|as|to)\s+|[.,]|$)/i,
        extract: (m, ctx) => ({
            subject: ctx.domain || 'user',
            predicate: 'uses',
            object: m[1].trim(),
            confidence: 0.4,
        }),
    },
    // ── Depends on / Integrates with ──────────────────────────────
    // "X depends on Y" / "X integrates with Y"
    {
        regex: /\b([A-Z][a-z]+[\w-]*(?:\s+[A-Z][\w-]*)*)\s+(?:depends\s+on|integrates?\s+with|connects?\s+to|talks?\s+to)\s+(.+?)(?:\.|,|$)/,
        extract: (m) => ({
            subject: m[1].trim(),
            predicate: m[0].includes('depend') ? 'depends-on' : 'integrates-with',
            object: cleanObject(m[2]),
            confidence: 0.45,
        }),
    },
    // ── Preferences ───────────────────────────────────────────────
    // "I prefer X over Y" / "we prefer X"
    {
        regex: /\b(?:I|we|i)\s+prefer\s+(.+?)\s+over\s+(.+?)(?:\.|,|$)/i,
        extract: (m) => ({
            subject: 'user',
            predicate: 'prefers',
            object: `${cleanObject(m[1])} over ${cleanObject(m[2])}`,
            confidence: 0.5,
        }),
    },
    // "I prefer X" (without "over")
    {
        regex: /\b(?:I|we|i)\s+prefer\s+(.+?)(?:\.|,|$)/i,
        extract: (m) => ({
            subject: 'user',
            predicate: 'prefers',
            object: cleanObject(m[1]),
            confidence: 0.4,
        }),
    },
    // ── Decisions ─────────────────────────────────────────────────
    // "decided to use X" / "going with X" / "chose X"
    {
        regex: /\b(?:decided\s+to\s+(?:use|go\s+with|switch\s+to)|going\s+with|chose|choosing)\s+(.+?)(?:\s+(?:for|because|since)\s+|[.,]|$)/i,
        extract: (m, ctx) => ({
            subject: ctx.domain || 'user',
            predicate: 'chose',
            object: cleanObject(m[1]),
            confidence: 0.5,
        }),
    },
    // ── Project structure ─────────────────────────────────────────
    // "X has/contains Y" / "X includes Y" — subject must be proper noun
    {
        regex: /\b([A-Z][a-z]+[\w-]*(?:\s+[A-Z][\w-]*)*)\s+(?:has|contains|includes)\s+(?:a\s+)?(.+?)(?:\.|,|$)/,
        extract: (m) => {
            const subject = m[1].trim();
            if (/^(The|This|That|It|There|Here|Some|Each|Every)$/i.test(subject))
                return null;
            return {
                subject,
                predicate: 'has',
                object: cleanObject(m[2]),
                confidence: 0.35,
            };
        },
    },
    // ── Deployed / Hosted ─────────────────────────────────────────
    // "X is deployed to Y" / "X is hosted on Y" — subject must be proper noun
    {
        regex: /\b([A-Z][a-z]+[\w-]*(?:\s+[A-Z][\w-]*)*)\s+(?:is\s+)?(?:deployed\s+(?:to|on)|hosted\s+(?:on|at))\s+(.+?)(?:\.|,|$)/,
        extract: (m) => {
            const subject = m[1].trim();
            if (/^(The|This|That|It)$/i.test(subject))
                return null;
            return {
                subject,
                predicate: 'deployed-to',
                object: cleanObject(m[2]),
                confidence: 0.45,
            };
        },
    },
    // ── Version ───────────────────────────────────────────────────
    // "X is at version Y" / "X v1.2.3" / "X version 1.2.3"
    {
        regex: /\b([A-Z][a-z]+[\w-]*(?:\s+[A-Z][\w-]*)*)\s+(?:is\s+(?:at\s+)?)?(?:version|v)\s*\.?\s*([\d]+\.[\d]+(?:\.[\d]+)?(?:-[\w.]+)?)/,
        extract: (m) => ({
            subject: m[1].trim(),
            predicate: 'has-version',
            object: m[2].trim(),
            confidence: 0.45,
        }),
    },
    // ── Ownership / Authorship ────────────────────────────────────
    // "X was created by Y" / "X was built by Y"
    {
        regex: /\b([A-Z][a-z]+[\w-]*(?:\s+[A-Z][\w-]*)*)\s+(?:is\s+|was\s+)?(?:owned|created|built|made|developed)\s+by\s+(.+?)(?:\.|,|$)/,
        extract: (m) => ({
            subject: m[1].trim(),
            predicate: 'created-by',
            object: cleanObject(m[2]),
            confidence: 0.4,
        }),
    },
];
// ── Object Cleanup ───────────────────────────────────────────────────
/**
 * Clean up extracted objects by stripping leading articles,
 * trailing prepositional phrases, and normalizing whitespace.
 */
function cleanObject(obj) {
    let cleaned = obj.trim();
    // Strip leading articles
    cleaned = cleaned.replace(/^(?:the|a|an)\s+/i, '');
    // Strip trailing prepositional phrases (for X, in X, as X, to X, because X, since X, when X)
    cleaned = cleaned.replace(/\s+(?:for|in|as|to|because|since|when|where|with|after|before|during)\s+.+$/i, '');
    // Strip trailing conjunctions
    cleaned = cleaned.replace(/\s+(?:and|but|or)\s+.+$/i, '');
    return cleaned.trim();
}
// ── Main Extraction Function ─────────────────────────────────────────
/**
 * Extract entity-relationship triples from memory content.
 * Returns raw extractions without persisting — caller decides what to save.
 */
export function extractTriples(content, context = {}) {
    const results = [];
    const seen = new Set();
    // Split into sentences for more precise matching.
    // Use lookbehind to avoid splitting on periods in version numbers (1.0.0) or abbreviations.
    const sentences = content
        .split(/(?<=[^0-9])[.!?]+\s+|[\n]+/)
        .map(s => s.replace(/[.!?]+$/, '').trim())
        .filter(s => s.length > 5);
    for (const sentence of sentences) {
        for (const pattern of PATTERNS) {
            const match = sentence.match(pattern.regex);
            if (!match)
                continue;
            const result = pattern.extract(match, context);
            if (!result)
                continue;
            // Skip if subject or object is too short or too long
            if (result.subject.length < 2 || result.subject.length > 80)
                continue;
            if (result.object.length < 2 || result.object.length > 120)
                continue;
            // Skip if object looks like a sentence fragment (too many words)
            if (result.object.split(/\s+/).length > 8)
                continue;
            // Normalize predicate
            result.predicate = result.predicate.toLowerCase().replace(/\s+/g, '-');
            // Deduplicate within this extraction
            const key = `${result.subject.toLowerCase()}|${result.predicate}|${result.object.toLowerCase()}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            results.push(result);
        }
    }
    return results;
}
/**
 * Extract triples from content and persist them to the knowledge graph.
 * Returns the number of triples added/reinforced.
 */
export async function extractAndPersistTriples(storage, content, context = {}) {
    const results = extractTriples(content, context);
    let count = 0;
    for (const result of results) {
        try {
            await addTriple(storage, result.subject, result.predicate, result.object, `auto-extract:${context.source ?? 'ingest'}`, result.confidence);
            count++;
        }
        catch {
            // Skip failed triples silently
        }
    }
    return count;
}
//# sourceMappingURL=kg-extractor.js.map