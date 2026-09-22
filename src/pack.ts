import { renderPrompt, renderRecord } from './render.js';
import { detectComparison, relevantTypes, resolveSeeds } from './resolve.js';
import { scoreCandidates, type ScoredCandidate } from './score.js';
import { traverse, type Candidate } from './traverse.js';
import type {
  ContextPackage,
  Dataset,
  ExcludedRecord,
  Mode,
  PackOptions,
  Seed,
  SelectedRecord,
} from './types.js';
import { byScoreThenId, estimateTokens, tokenize } from './util.js';
import { VERSION } from './version.js';

interface ModeConfig {
  budget: number;
  minScore: number;
  typeCap: number;
  textTrunc: number;
}

export const MODES: Record<Mode, ModeConfig> = {
  broad: { budget: 16000, minScore: 0.05, typeCap: 40, textTrunc: 1200 },
  balanced: { budget: 8000, minScore: 0.12, typeCap: 20, textTrunc: 600 },
  aggressive: { budget: 4000, minScore: 0.25, typeCap: 8, textTrunc: 250 },
};

/**
 * The core pipeline: resolve -> traverse -> score -> pack -> render.
 * Pure and deterministic: same dataset + question + options => same package.
 */
export function packContext(ds: Dataset, question: string, opts: PackOptions = {}): ContextPackage {
  const mode: Mode = opts.mode ?? 'balanced';
  const cfg = MODES[mode];
  const budget = opts.budgetTokens ?? cfg.budget;
  const strategy = opts.strategy ?? 'graph';

  let seeds: Seed[] = [];
  let candidates: ScoredCandidate[];
  if (strategy === 'flat') {
    candidates = flatCandidates(ds, question);
  } else {
    seeds = resolveSeeds(ds, question, opts.maxSeeds ?? 4);
    const traversed = traverse(ds, seeds, {
      depth: opts.depth ?? 3,
      relevantTypes: relevantTypes(ds, question),
      comparison: detectComparison(question),
    });
    candidates = scoreCandidates(ds, [...traversed.values()], question);
  }
  candidates.sort(byScoreThenId);

  // Greedy pack under the budget with per-type caps and score threshold.
  const selected: SelectedRecord[] = [];
  const excluded: ExcludedRecord[] = [];
  const typeCounts = new Map<string, number>();
  let tokensAfter = 0;
  let tokensBefore = 0;
  for (const c of candidates) {
    const e = ds.entities.get(c.id);
    if (!e) continue;
    const cost = estimateTokens(renderRecord(ds, e, cfg.textTrunc));
    tokensBefore += cost;
    if (c.reason !== 'seed' && c.score < cfg.minScore) {
      excluded.push({ id: c.id, reason: 'low-score', score: c.score });
      continue;
    }
    const count = typeCounts.get(c.type) ?? 0;
    if (c.reason !== 'seed' && count >= cfg.typeCap) {
      excluded.push({ id: c.id, reason: 'redundant', score: c.score });
      continue;
    }
    if (tokensAfter + cost > budget) {
      excluded.push({ id: c.id, reason: 'budget', score: c.score });
      continue;
    }
    typeCounts.set(c.type, count + 1);
    tokensAfter += cost;
    selected.push({ id: c.id, type: c.type, score: c.score, via: c.via, reason: c.reason, tokensEstimate: cost });
  }

  const prompt = renderPrompt(ds, question, selected, cfg.textTrunc);
  const reduction = ds.tokensEstimate > 0 ? Math.round((1 - tokensAfter / ds.tokensEstimate) * 100) : 0;

  return {
    formatVersion: 1,
    tool: 'grainpack',
    toolVersion: VERSION,
    question,
    dataset: { name: ds.name, records: ds.entities.size, tokensEstimate: ds.tokensEstimate },
    mode,
    strategy,
    budgetTokens: budget,
    seeds,
    selected,
    excluded,
    stats: {
      considered: candidates.length,
      selected: selected.length,
      excluded: excluded.length,
      tokensBefore,
      tokensAfter,
      reductionPct: reduction,
    },
    prompt,
  };
}

/**
 * The honest baseline: rank EVERY record by lexical overlap with the
 * question. No traversal, no relationships, no grain. This is what a naive
 * chat-over-data setup effectively does, and what the eval traps catch.
 */
function flatCandidates(ds: Dataset, question: string): ScoredCandidate[] {
  const qTokens = tokenize(question);
  const qSet = new Set(qTokens);
  const out: ScoredCandidate[] = [];
  for (const e of ds.entities.values()) {
    const hits = [...(ds.entityTokens.get(e.id) ?? [])].filter((t) => qSet.has(t)).length;
    if (hits === 0) continue;
    const score = Math.round(Math.min(1, hits / Math.max(1, qTokens.length)) * 1000) / 1000;
    const c: Candidate = { id: e.id, type: e.type, hops: 0, via: [], reason: 'lexical', seedIndex: 0 };
    out.push({ ...c, score });
  }
  return out;
}
