#!/usr/bin/env node
/**
 * Engram CLI router.
 *
 * Usage:
 *   engram-mcp                                                 → run MCP stdio server (back-compat)
 *   engram-mcp search --query <q> [--project <p>] [--limit N]
 *                     [--min-relevance F] [--format json|text]
 *   engram-mcp query  [--project <p>] [--tier <t>]
 *                     [--min-importance F] [--limit N] [--format json|text]
 *   engram-mcp help
 *
 * The CLI is additive — it wraps the same search/storage primitives the
 * MCP server uses so hook scripts can pull memories without speaking
 * stdio JSON-RPC.
 */
export {};
