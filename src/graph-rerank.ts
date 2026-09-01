/**
 * Graph-aware reranking — a 1-hop expansion over the KG that operates
 * on similarity-search candidates.
 *
 * This is a lite version of HippoRAG (Gutiérrez et al, NeurIPS 2024).
 * Full HippoRAG runs personalized PageRank from query-seed entities;
 * this implementation does a single-hop expansion plus score boosting.
 * Same spirit, contained scope: real graph-awareness without the
 * algorithmic complexity of PPR convergence.
 *
 * Procedure:
 *   1. Take the top-K similarity-ranked candidates from `search()`.
 *   2. For each candidate, look up KG triples whose `source` field is
 *      that chunk's id — these are the entity assertions the chunk
 *      contributed.
 *   3. From those triples, gather the *connected entities* (subjects
 *      and objects).
 *   4. For each connected entity, find OTHER chunks in the candidate
 *      pool whose content mentions the entity (case-insensitive
 *      substring match).
 *   5. Boost those chunks' scores. The boost is conservative — a chunk
 *      that gets connected via 2+ entities gets a stronger lift than
 *      one connected via 1.
 *
 * Why this helps LoCoMo R@k: the dataset has multi-hop QA pairs
 * ("what city does X live in, and what's the weather like there?")
 * where the answer chunks aren't the top similarity match — they're
 * one graph hop away. Pure similarity ranking misses them; graph-
 * aware reranking catches them.
 *
 * Lower bound on quality: when no KG triples exist for any candidate,
 * results are returned unchanged. The function is safe to enable as
 * a default; it just doesn't help on memory stores without graph data.
 */

import type { Storage } from './storage.js';
import type { SearchResult } from './types.js';

const MAX_CANDIDATES_TO_EXPAND = 20;
const MAX_ENTITIES_PER_CANDIDATE = 5;
const BOOST_PER_CONNECTION = 0.15;
const MAX_BOOST = 0.5;

type Triple = Awaited<ReturnType<Storage['queryTriples']>>[number];

async function fetchTriplesBySource(storage: Storage): Promise<Map<string, Triple[]>> {
  const all = await storage.queryTriples({});
  const bySource = new Map<string, Triple[]>();
  for (const t of all) {
    if (!t.source) continue;
    const list = bySource.get(t.source) ?? [];
    list.push(t);
    bySource.set(t.source, list);
  }
  return bySource;
}

/**
 * Rerank candidates using a 1-hop KG expansion. Returns a new array
 * (does not mutate inputs); preserves all candidates, only reorders.
 */
export async function graphAwareRerank(
  storage: Storage,
  candidates: SearchResult[],
): Promise<SearchResult[]> {
  if (candidates.length === 0) return candidates;

  // Limit how many candidates we look up triples for — at typical
  // top-K (10-50), this is the whole list. Cap protects against
  // pathological inputs.
  const expandable = candidates.slice(0, MAX_CANDIDATES_TO_EXPAND);

  // Fetch the triple store once and group by contributing chunk;
  // per-candidate queryTriples calls were a full scan each.
  const triplesBySource = await fetchTriplesBySource(storage);

  // Step 1+2: gather entities mentioned by each candidate's contributed
  // triples. Map entity → set of candidate ids that contributed it.
  const entityToCandidateIds = new Map<string, Set<string>>();
  const entitiesByCandidate = new Map<string, Set<string>>();

  for (const cand of expandable) {
    const id = cand.chunk.id;
    const triples = triplesBySource.get(id) ?? [];
    if (triples.length === 0) continue;

    const entities = new Set<string>();
    for (const t of triples) {
      // Cheap dedup — both subject and object count as entities.
      entities.add(t.subject.toLowerCase());
      entities.add(t.object.toLowerCase());
    }
    // Cap per candidate so a single chunk that contributed 50 triples
    // doesn't dominate the entity index.
    const capped = Array.from(entities).slice(0, MAX_ENTITIES_PER_CANDIDATE);
    entitiesByCandidate.set(id, new Set(capped));
    for (const e of capped) {
      let set = entityToCandidateIds.get(e);
      if (!set) {
        set = new Set<string>();
        entityToCandidateIds.set(e, set);
      }
      set.add(id);
    }
  }

  if (entityToCandidateIds.size === 0) {
    // No graph data on these candidates — return unchanged.
    return candidates;
  }

  // Step 3+4: for each candidate, count how many connected entities
  // appear in its content. A candidate is "connected" via an entity
  // E if some OTHER candidate contributed E and this candidate's
  // content mentions E.
  const connectionCount = new Map<string, number>();

  for (const cand of candidates) {
    const id = cand.chunk.id;
    const ownEntities = entitiesByCandidate.get(id) ?? new Set<string>();
    const contentLower = cand.chunk.content.toLowerCase();
    let count = 0;
    for (const [entity, contributors] of entityToCandidateIds.entries()) {
      // Skip entities this candidate itself contributed.
      if (ownEntities.has(entity)) continue;
      // Skip entities only this candidate would have matched (no other contributors).
      if (contributors.size === 0) continue;
      if (contributors.has(id)) continue;
      // Cheap substring check — entity name appears in content.
      if (contentLower.includes(entity)) count++;
    }
    if (count > 0) connectionCount.set(id, count);
  }

  // Step 5: apply the boost.
  const boosted = candidates.map((cand) => {
    const count = connectionCount.get(cand.chunk.id) ?? 0;
    const boost = Math.min(MAX_BOOST, count * BOOST_PER_CONNECTION);
    return {
      ...cand,
      score: cand.score + boost,
    };
  });

  boosted.sort((a, b) => b.score - a.score);
  return boosted;
}

/**
 * Personalized PageRank rerank — full HippoRAG (Gutiérrez et al,
 * NeurIPS 2024).
 *
 * Generalizes the 1-hop lite version above into a multi-iteration
 * walk over the KG. Boosts chunks whose contributed entities are
 * highly reachable from the query's seed entities, where
 * "reachable" is measured by PPR convergence.
 *
 * Algorithm:
 *   1. Build forward + reverse adjacency from KG triples (the graph
 *      is undirected for retrieval purposes — both subject→object
 *      and object→subject edges count).
 *   2. Identify SEED entities from the top-K similarity candidates
 *      (entities each candidate contributed). Mass distributed
 *      uniformly across seeds.
 *   3. Run damped random-walk iterations:
 *        r_new = (1-α) * P * r + α * s
 *      where P is the row-normalized transition matrix, s is the
 *      seed vector, α is the teleport probability (0.15 — standard).
 *   4. After convergence (or max iterations), score each candidate
 *      chunk by Σ(PPR-weight of entities the chunk contributed).
 *
 * Caps:
 *   - 50 iterations max (typical convergence in 10-20)
 *   - 1e-4 L1-norm convergence threshold
 *   - 500 entity graph cap (largest LoCoMo conversation produces
 *     ~200-300 distinct entities; this caps pathological inputs)
 *
 * Falls back to the lite 1-hop version when:
 *   - candidates is empty
 *   - no candidate contributed any KG triples
 *   - graph contains < 4 entities (not enough structure for PPR
 *     to differentiate)
 */
const PPR_ALPHA = 0.15;           // Teleport probability (HippoRAG paper default)
const PPR_MAX_ITERATIONS = 50;
const PPR_CONVERGENCE_L1 = 1e-4;
const PPR_MAX_GRAPH_NODES = 500;
const PPR_BOOST_PER_UNIT = 1.0;   // Multiplied with normalized PPR mass; tuned conservative
const PPR_MAX_BOOST = 0.5;

export async function graphAwareRerankPPR(
  storage: Storage,
  candidates: SearchResult[],
): Promise<SearchResult[]> {
  if (candidates.length === 0) return candidates;
  const expandable = candidates.slice(0, MAX_CANDIDATES_TO_EXPAND);

  // Step 1+2: candidate → entities they contributed (same as lite).
  const entitiesByCandidate = new Map<string, Set<string>>();
  const seedEntities = new Set<string>();

  const triplesBySource = await fetchTriplesBySource(storage);

  for (const cand of expandable) {
    const id = cand.chunk.id;
    const triples = triplesBySource.get(id) ?? [];
    if (triples.length === 0) continue;
    const entities = new Set<string>();
    for (const t of triples) {
      entities.add(t.subject.toLowerCase());
      entities.add(t.object.toLowerCase());
    }
    const capped = Array.from(entities).slice(0, MAX_ENTITIES_PER_CANDIDATE);
    entitiesByCandidate.set(id, new Set(capped));
    for (const e of capped) seedEntities.add(e);
  }

  if (seedEntities.size < 4) {
    // Not enough graph structure for PPR — fall back to lite.
    return graphAwareRerank(storage, candidates);
  }

  // Step 3: build the FULL forward+reverse adjacency from the active
  // KG — not just the seed entities' direct neighbors. PPR needs the
  // graph it's walking on.
  const allTriples = await storage.queryTriples({ activeOnly: true });
  const adjacency = new Map<string, Set<string>>();
  for (const t of allTriples) {
    const subj = t.subject.toLowerCase();
    const obj = t.object.toLowerCase();
    if (!adjacency.has(subj)) adjacency.set(subj, new Set());
    if (!adjacency.has(obj)) adjacency.set(obj, new Set());
    adjacency.get(subj)!.add(obj);
    adjacency.get(obj)!.add(subj);
  }

  if (adjacency.size > PPR_MAX_GRAPH_NODES) {
    // Pathological graph — fall back to lite to avoid PPR over a
    // huge sparse matrix.
    return graphAwareRerank(storage, candidates);
  }

  // Step 4: initialize seed vector. Uniform over seed entities,
  // zero elsewhere.
  const nodes = Array.from(adjacency.keys());
  const indexOf = new Map<string, number>();
  for (let i = 0; i < nodes.length; i++) indexOf.set(nodes[i]!, i);

  const seedVec = new Float64Array(nodes.length);
  const seedWeight = 1 / seedEntities.size;
  for (const seed of seedEntities) {
    const idx = indexOf.get(seed);
    if (idx !== undefined) seedVec[idx] = seedWeight;
  }

  // Initial rank = seed vector
  let rank = Float64Array.from(seedVec);
  const next = new Float64Array(nodes.length);

  // Pre-compute out-degree for normalization (graph is undirected
  // so out-degree = in-degree = neighbor count).
  const outDegree = new Float64Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    outDegree[i] = adjacency.get(nodes[i]!)!.size;
  }

  // Step 5: iterate PPR until convergence or cap.
  for (let iter = 0; iter < PPR_MAX_ITERATIONS; iter++) {
    next.fill(0);
    // Distribute current rank along edges
    for (let i = 0; i < nodes.length; i++) {
      if (rank[i] === 0 || outDegree[i] === 0) continue;
      const share = rank[i]! / outDegree[i]!;
      for (const neighbor of adjacency.get(nodes[i]!)!) {
        const j = indexOf.get(neighbor);
        if (j !== undefined) next[j]! += share;
      }
    }
    // Apply damping + teleport
    let l1Diff = 0;
    for (let i = 0; i < nodes.length; i++) {
      const updated = (1 - PPR_ALPHA) * next[i]! + PPR_ALPHA * seedVec[i]!;
      l1Diff += Math.abs(updated - rank[i]!);
      rank[i] = updated;
    }
    if (l1Diff < PPR_CONVERGENCE_L1) break;
  }

  // Step 6: score each candidate chunk by sum of PPR weights over
  // entities it contributed. Normalize by the max PPR weight in the
  // graph so the boost is in [0, MAX_BOOST].
  let maxRank = 0;
  for (let i = 0; i < rank.length; i++) if (rank[i]! > maxRank) maxRank = rank[i]!;
  if (maxRank === 0) return candidates;

  const chunkPprScore = new Map<string, number>();
  for (const cand of candidates) {
    const own = entitiesByCandidate.get(cand.chunk.id) ?? new Set<string>();
    let score = 0;
    for (const ent of own) {
      const idx = indexOf.get(ent);
      if (idx !== undefined) score += rank[idx]! / maxRank;
    }
    if (score > 0) chunkPprScore.set(cand.chunk.id, score);
  }

  const boosted = candidates.map((cand) => {
    const pprScore = chunkPprScore.get(cand.chunk.id) ?? 0;
    const boost = Math.min(PPR_MAX_BOOST, PPR_BOOST_PER_UNIT * pprScore);
    return { ...cand, score: cand.score + boost };
  });
  boosted.sort((a, b) => b.score - a.score);
  return boosted;
}

/**
 * Telemetry helper — returns the boost that *would* be applied to
 * each candidate without actually re-ranking them. Useful for
 * debugging and for the LoCoMo bench's per-question diagnostics.
 */
export async function explainGraphRerank(
  storage: Storage,
  candidates: SearchResult[],
): Promise<Array<{ id: string; score: number; connectionCount: number; boost: number }>> {
  const reranked = await graphAwareRerank(storage, candidates);
  // Re-zip: the reranked array carries the boosted score; the
  // diff against original gives boost magnitude.
  const originalById = new Map(candidates.map((c) => [c.chunk.id, c.score]));
  return reranked.map((r) => {
    const original = originalById.get(r.chunk.id) ?? r.score;
    const boost = r.score - original;
    return {
      id: r.chunk.id,
      score: r.score,
      connectionCount: Math.round(boost / BOOST_PER_CONNECTION),
      boost,
    };
  });
}
