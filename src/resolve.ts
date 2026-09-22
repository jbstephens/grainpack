import { entityLabel } from './dataset.js';
import type { Dataset, Seed } from './types.js';
import { tokenize } from './util.js';

const COMPARISON_RE =
  /\b(vs\.?|versus|compare[ds]?|comparison|outperform(?:ed|s)?|underperform(?:ed|s)?|than|difference|differ|strongest|weakest|best|worst)\b/i;

export function detectComparison(question: string): boolean {
  return COMPARISON_RE.test(question);
}

/** Entity types the question mentions by name or alias (gates lazy edges). */
export function relevantTypes(ds: Dataset, question: string): Set<string> {
  const qTokens = new Set(tokenize(question));
  const types = new Set<string>();
  for (const [type, def] of Object.entries(ds.schema.entities)) {
    const names = [type, ...(def.aliases ?? [])];
    for (const name of names) {
      if (tokenize(name).some((t) => qTokens.has(t))) {
        types.add(type);
        break;
      }
    }
  }
  return types;
}

/**
 * Resolve the question to seed entities by lexical match against labels and
 * fields. Deterministic; no LLM involved.
 */
export function resolveSeeds(ds: Dataset, question: string, maxSeeds = 4): Seed[] {
  const qTokens = tokenize(question);
  if (qTokens.length === 0) return [];
  const qSet = new Set(qTokens);

  // Token specificity: rare tokens identify entities; ubiquitous ones
  // ("q3", a year) do not. Weight by inverse document frequency, and require
  // every seed to match at least one distinctive token.
  const df = (t: string): number => ds.tokenIndex.get(t)?.size ?? 0;
  const weight = (t: string): number => 1 / Math.log2(2 + df(t));
  const distinctiveCutoff = Math.max(8, Math.floor(ds.entities.size * 0.05));

  const scored: Array<Seed & { labelHits: number }> = [];
  for (const e of ds.entities.values()) {
    const labelTokens = tokenize(entityLabel(ds, e));
    if (labelTokens.length === 0) continue;
    const matchedTokens = labelTokens.filter((t) => qSet.has(t));
    if (matchedTokens.length === 0) continue;
    if (!matchedTokens.some((t) => df(t) <= distinctiveCutoff)) continue;
    const labelWeight = labelTokens.reduce((s, t) => s + weight(t), 0);
    const matchedWeight = matchedTokens.reduce((s, t) => s + weight(t), 0);
    const questionWeight = qTokens.reduce((s, t) => s + weight(t), 0);
    const fieldHits = [...(ds.entityTokens.get(e.id) ?? [])].filter((t) => qSet.has(t)).length;
    // How much of the label the question covers (by weight), plus how much
    // of the question this label explains, plus a small field-match nudge.
    const score =
      0.6 * (labelWeight > 0 ? matchedWeight / labelWeight : 0) +
      0.3 * (questionWeight > 0 ? matchedWeight / questionWeight : 0) +
      Math.min(0.1, 0.02 * Math.max(0, fieldHits - matchedTokens.length));
    if (score < 0.3) continue;
    scored.push({
      id: e.id,
      matchedOn: `label ~ [${matchedTokens.join(', ')}]`,
      score: round3(score),
      labelHits: matchedTokens.length,
    });
  }
  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.id < b.id ? -1 : 1));

  // Relative quality gate: a seed far below the best match is noise from a
  // partially-shared name, not a second subject of the question.
  const top = scored[0]?.score ?? 0;
  let seeds = scored
    .filter((s) => s.score >= 0.55 * top)
    .slice(0, maxSeeds)
    .map(({ id, matchedOn, score }) => ({ id, matchedOn, score }));

  // Fallback: no label matched — seed from types the question names by alias.
  if (seeds.length === 0) {
    const types = relevantTypes(ds, question);
    const fallback: Seed[] = [];
    for (const type of [...types].sort()) {
      const candidates = (ds.byType.get(type) ?? [])
        .map((e) => {
          const fieldHits = [...(ds.entityTokens.get(e.id) ?? [])].filter((t) => qSet.has(t)).length;
          return { id: e.id, score: fieldHits };
        })
        .filter((c) => c.score > 0)
        .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.id < b.id ? -1 : 1))
        .slice(0, maxSeeds);
      for (const c of candidates) {
        fallback.push({ id: c.id, matchedOn: `type alias "${type}" + field match`, score: round3(Math.min(0.5, 0.1 * c.score)) });
      }
    }
    seeds = fallback.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.id < b.id ? -1 : 1)).slice(0, maxSeeds);
  }
  return seeds;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
