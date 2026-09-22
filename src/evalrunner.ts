import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { generateAnswer, hasApiKey, judgeAnswer } from './answer.js';
import { packContext } from './pack.js';
import type { Dataset, EvalCase, EvalResult, Strategy } from './types.js';

export async function loadEvalCases(dir: string): Promise<EvalCase[]> {
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  const cases: EvalCase[] = [];
  for (const f of files) {
    cases.push(JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')) as EvalCase);
  }
  return cases;
}

export interface RunEvalOptions {
  strategy?: Strategy;
  /** Generate + judge answers when an API key is present. */
  judge?: boolean;
  model?: string;
  log?: (msg: string) => void;
}

/**
 * Tier 1 (always, deterministic): every mustCite id present in the package's
 * selection, within budget. Tier 2 (opt-in, needs a key): generate the
 * answer and have a judge model check mustNotConclude / shouldSurface.
 */
export async function runEvalCase(ds: Dataset, evalCase: EvalCase, opts: RunEvalOptions = {}): Promise<EvalResult> {
  const strategy = opts.strategy ?? 'graph';
  const pkg = packContext(ds, evalCase.question, {
    strategy,
    mode: evalCase.mode ?? 'balanced',
    budgetTokens: evalCase.budgetTokens,
  });
  const selectedIds = new Set(pkg.selected.map((s) => s.id));
  const missing = evalCase.mustCite.filter((id) => !selectedIds.has(id));
  const result: EvalResult = {
    name: evalCase.name,
    strategy,
    passedCitations: missing.length === 0,
    missingCitations: missing,
    withinBudget: pkg.stats.tokensAfter <= pkg.budgetTokens,
    tokensAfter: pkg.stats.tokensAfter,
    judged: null,
  };
  if (opts.judge && hasApiKey() && (evalCase.mustNotConclude?.length || evalCase.shouldSurface)) {
    opts.log?.(`  generating + judging answer for "${evalCase.name}" (${strategy})…`);
    const answer = await generateAnswer(pkg, { model: opts.model });
    result.judged = await judgeAnswer(answer, evalCase, { model: opts.model });
  }
  return result;
}

export async function runEvals(ds: Dataset, cases: EvalCase[], opts: RunEvalOptions = {}): Promise<EvalResult[]> {
  const results: EvalResult[] = [];
  for (const c of cases) results.push(await runEvalCase(ds, c, opts));
  return results;
}

export function evalPassed(r: EvalResult): boolean {
  return r.passedCitations && r.withinBudget && (r.judged ? r.judged.passed : true);
}
