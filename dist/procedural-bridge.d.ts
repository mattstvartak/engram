import { Storage } from './storage.js';
/**
 * Procedural bridge — shared interchange between Engram and Persona.
 *
 * Both servers read/write a neutral JSON file at ~/.claude/procedural-bridge.json.
 * Neither imports code from the other. The AI client can also trigger sync
 * explicitly via tools.
 *
 * Engram exports its procedural rules with confidence > 0.3.
 * Engram imports Persona-sourced rules as new ProceduralRules with low initial confidence.
 */
export interface BridgeRule {
    id: string;
    rule: string;
    domain: string;
    confidence: number;
    source: 'engram' | 'persona';
    sourceId: string;
    evidence: string[];
    createdAt: string;
    updatedAt: string;
}
export interface ProceduralInterchange {
    version: 1;
    lastUpdated: string;
    rules: BridgeRule[];
}
export declare function loadBridgeFile(): ProceduralInterchange;
export declare function saveBridgeFile(data: ProceduralInterchange): void;
export declare function exportRulesToBridge(storage: Storage): Promise<number>;
export declare function importRulesFromBridge(storage: Storage): Promise<{
    imported: number;
    reinforced: number;
    conflicts: number;
}>;
export declare function syncBridge(storage: Storage): Promise<{
    exported: number;
    imported: number;
    reinforced: number;
    conflicts: number;
}>;
