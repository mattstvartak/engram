/**
 * Sentence splitting that does not break inside backticks or after "e.g.", "i.e.", "etc." and
 * "vs.". Both the chunker and the rule extractor split text into sentences, and both had the
 * same naive `[.!?]` rule; the chunker's version stored memories cut at "(e.g." for months.
 *
 * Placeholders are built from character codes rather than written as escapes so the source stays
 * plain ASCII.
 */
export interface SplitOptions {
    /** Treat a semicolon as a boundary too. The extractor wants this; the chunker does not. */
    semicolons?: boolean;
    /** Treat a newline as a boundary. */
    newlines?: boolean;
}
export declare function splitSentences(text: string, opts?: SplitOptions): string[];
