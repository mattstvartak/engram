import type { SmartMemoryConfig, ProceduralRule } from './types.js';
import { Storage } from './storage.js';
export interface ExtractOptions {
    /** Project slug the source belongs to; empty or absent means the rule applies everywhere. */
    scope?: string;
    /** Projects the store knows about, so a rule whose label names one can be scoped to it. */
    knownScopes?: Iterable<string>;
    /** Starting confidence for new rules; a rule from a 0.95-importance correction should not start level with one from a passing note. */
    seedConfidence?: number;
}
export declare function normalizeScope(domain: string | undefined | null): string;
export declare function extractRules(config: SmartMemoryConfig, storage: Storage, messages: Array<{
    role: string;
    content: string;
}>, signals?: Array<{
    type: string;
    confidence: number;
}>, opts?: ExtractOptions): Promise<void>;
export interface SplitDirective {
    /** The labels stripped off the front, joined; empty when there were none. */
    label: string;
    directive: string;
}
/**
 * The directive in a sentence and the labels that were in front of it, or null when the sentence
 * is not one. Labels matter because they often name the project a rule belongs to.
 */
export declare function splitDirective(sentence: string): SplitDirective | null;
export declare function directiveFrom(sentence: string): string | null;
/**
 * The project a rule belongs to, read off its label when the memory itself carried no domain.
 * "Stave-admin git/deploy workflow rule (Matt set this):" names stave; the longest known slug
 * that appears wins, so "elevate-pryzm" beats "elevate".
 */
export declare function scopeFromLabel(label: string, knownScopes: Iterable<string>): string;
/**
 * Split a message into sentences without breaking inside backticks or after "e.g.", "i.e.",
 * "etc." and "vs.". Semicolons count as a break: a correction often chains two directives.
 */
export declare function sentencesOf(content: string): string[];
export declare function ruleWords(text: string): Set<string>;
/**
 * Containment catches a short rule restated inside a longer one; the bar relaxes a little for
 * rules with more content words, where three shared words out of five is not chance. Jaccard
 * catches two long rules that mostly overlap. Semantic restatements with different vocabulary
 * are the LLM path's job, not this one's.
 */
export declare function ruleSimilarity(a: string, b: string): number;
export declare function findMatchingRule(newRule: string, existing: ProceduralRule[]): number;
export declare function formatRulesForPrompt(storage: Storage, scope?: string): Promise<string>;
