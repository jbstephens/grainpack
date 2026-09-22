import { neighbors } from './dataset.js';
import type { Dataset, Seed, SelectReason, Via } from './types.js';

export interface Candidate {
  id: string;
  type: string;
  hops: number;
  via: Via[];
  reason: SelectReason;
  /** Index of the seed this node was first reached from. */
  seedIndex: number;
}

export interface TraverseOptions {
  depth?: number;
  /** Entity types the question names — gates lazy edges. */
  relevantTypes?: Set<string>;
  /** Treat secondary seeds' subtrees as comparison evidence. */
  comparison?: boolean;
  siblingCapPerNode?: number;
  /**
   * Sibling expansion only runs through shared neighbors with at most this
   * many connections. Sharing a hub (an audience of 80 sends, a global tag)
   * is not comparability; sharing a low-fanout node (the same asset, the
   * same quarter) is.
   */
  maxSiblingFanout?: number;
}

/**
 * BFS from seeds along typed edges, then sibling expansion (co-neighbors
 * through shared nodes), then a one-hop expansion of siblings so their own
 * context (metrics, audiences, …) comes along.
 */
export function traverse(ds: Dataset, seeds: Seed[], opts: TraverseOptions = {}): Map<string, Candidate> {
  const depth = opts.depth ?? 3;
  const siblingCap = opts.siblingCapPerNode ?? 5;
  const maxFanout = opts.maxSiblingFanout ?? 24;
  const relevant = opts.relevantTypes ?? new Set<string>();
  const candidates = new Map<string, Candidate>();

  const crossable = (edgeType: string): boolean => {
    const rel = ds.schema.relationships[edgeType];
    if (!rel) return true; // undeclared edges are crossed (validation already warned)
    if (rel.expand === 'lazy') return relevant.has(rel.to) || relevant.has(rel.from);
    return true;
  };

  // --- BFS from each seed ---
  const queue: Candidate[] = [];
  seeds.forEach((seed, seedIndex) => {
    const e = ds.entities.get(seed.id);
    if (!e) return;
    if (!candidates.has(seed.id)) {
      const c: Candidate = { id: seed.id, type: e.type, hops: 0, via: [], reason: 'seed', seedIndex };
      candidates.set(seed.id, c);
      queue.push(c);
    }
  });
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    if (cur.hops >= depth) continue;
    // Hubs are context, not corridors: a node with huge fanout (a broad
    // audience, a global tag) is worth including but not traversing through —
    // expanding it would pull in everything it touches. Seeds always expand.
    const degree = (ds.out.get(cur.id)?.length ?? 0) + (ds.in.get(cur.id)?.length ?? 0);
    if (cur.reason !== 'seed' && degree > maxFanout) continue;
    for (const { edge, other } of neighbors(ds, cur.id)) {
      if (candidates.has(other)) continue;
      if (!crossable(edge)) continue;
      const e = ds.entities.get(other);
      if (!e) continue;
      const reason: SelectReason =
        opts.comparison && cur.seedIndex > 0 ? 'comparison' : 'traversal';
      const c: Candidate = {
        id: other,
        type: e.type,
        hops: cur.hops + 1,
        via: [...cur.via, { edge, from: cur.id }],
        reason: cur.reason === 'seed' || cur.reason === 'traversal' || cur.reason === 'comparison' ? reason : cur.reason,
        seedIndex: cur.seedIndex,
      };
      candidates.set(other, c);
      queue.push(c);
    }
  }

  // --- Sibling expansion: for near nodes, find co-neighbors through shared nodes ---
  const near = [...candidates.values()].filter((c) => c.hops <= 1);
  const siblings: Candidate[] = [];
  for (const node of near) {
    for (const { edge, other: shared, direction } of neighbors(ds, node.id)) {
      if (!crossable(edge)) continue;
      // Others connected to the same shared node via the same edge type, same direction.
      const others =
        direction === 'out'
          ? (ds.in.get(shared) ?? []).filter((x) => x.edge === edge).map((x) => x.from)
          : (ds.out.get(shared) ?? []).filter((x) => x.edge === edge).map((x) => x.to);
      if (others.length > maxFanout) continue; // hub, not a meaningful comparison set
      let added = 0;
      for (const sib of others) {
        if (sib === node.id || candidates.has(sib)) continue;
        if (added >= siblingCap) break;
        const e = ds.entities.get(sib);
        if (!e) continue;
        const c: Candidate = {
          id: sib,
          type: e.type,
          hops: node.hops + 2,
          via: [{ edge, sharedNeighbor: shared }],
          reason: 'sibling',
          seedIndex: node.seedIndex,
        };
        candidates.set(sib, c);
        siblings.push(c);
        added++;
      }
    }
  }

  // --- One hop out from each sibling so its own grain context comes along ---
  for (const sib of siblings) {
    let added = 0;
    for (const { edge, other } of neighbors(ds, sib.id)) {
      if (candidates.has(other) || !crossable(edge)) continue;
      const rel = ds.schema.relationships[edge];
      if (rel?.expand === 'lazy') continue;
      if (added >= 8) break;
      const e = ds.entities.get(other);
      if (!e) continue;
      const c: Candidate = {
        id: other,
        type: e.type,
        hops: sib.hops + 1,
        via: [...sib.via, { edge, from: sib.id }],
        reason: 'sibling',
        seedIndex: sib.seedIndex,
      };
      candidates.set(other, c);
      added++;
    }
  }

  // --- Salient leaves always ride along: for EVERY candidate, pull in
  // neighbors whose type declares a salience config (metrics and the like),
  // even one hop past the depth limit. A record without its numbers is not
  // comparable evidence. ---
  for (const node of [...candidates.values()]) {
    let added = 0;
    for (const { edge, other } of neighbors(ds, node.id)) {
      if (candidates.has(other) || !crossable(edge)) continue;
      const e = ds.entities.get(other);
      if (!e || !ds.schema.entities[e.type]?.salience) continue;
      if (added >= 4) break;
      candidates.set(other, {
        id: other,
        type: e.type,
        hops: node.hops + 1,
        via: [...node.via, { edge, from: node.id }],
        reason: node.reason === 'seed' ? 'traversal' : node.reason,
        seedIndex: node.seedIndex,
      });
      added++;
    }
  }

  return candidates;
}
