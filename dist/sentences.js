/**
 * Sentence splitting that does not break inside backticks or after "e.g.", "i.e.", "etc." and
 * "vs.". Both the chunker and the rule extractor split text into sentences, and both had the
 * same naive `[.!?]` rule; the chunker's version stored memories cut at "(e.g." for months.
 *
 * Placeholders are built from character codes rather than written as escapes so the source stays
 * plain ASCII.
 */
const PUNCT = ['.', '!', '?', ';'];
const holder = (i) => String.fromCharCode(1 + i);
const HOLDERS = new RegExp('[' + holder(0) + '-' + holder(3) + ']', 'g');
const mask = (m) => m.replace(/[.!?;]/g, ch => holder(PUNCT.indexOf(ch)));
const unmask = (s) => s.replace(HOLDERS, ch => PUNCT[ch.charCodeAt(0) - 1]);
export function splitSentences(text, opts = {}) {
    // Brackets too: a parenthetical that spans a sentence end ("(see Kit.make_dot(). It is
    // separate.)") must not be split at the period inside it, or the piece closes with the bracket
    // still open. Innermost, unnested spans only; a bracket left open by the author stays open.
    const masked = text
        .replace(/`[^`]*`/g, mask)
        .replace(/\((?:[^()\n]|\([^()\n]*\)){0,400}\)/g, mask)
        .replace(/\b(?:e\.g|i\.e|etc|vs)\./gi, mask);
    const boundary = opts.semicolons ? '[.!?;]' : '[.!?]';
    const pattern = new RegExp(`(?<=${boundary})\\s+${opts.newlines ? '|(?<=\\n)' : ''}`);
    return masked
        .split(pattern)
        .map(s => unmask(s).trim())
        .filter(Boolean);
}
//# sourceMappingURL=sentences.js.map