import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { loadDataset } from '../src/dataset.js';
import { loadEvalCases, runEvals } from '../src/evalrunner.js';

/**
 * The repo's own product claim, continuously verified: on the bundled
 * synthetic marketing dataset, graph retrieval passes every grain-trap eval,
 * and the flat lexical baseline fails the retrieval-tier traps.
 */
const here = path.dirname(new URL(import.meta.url).pathname);
const dataPath = path.resolve(here, '../../examples/marketing/dataset.json');
const evalsDir = path.resolve(here, '../../examples/marketing/evals');

test('graph strategy passes all grain-trap evals on the example dataset', async () => {
  const { dataset, problems } = await loadDataset(dataPath);
  assert.equal(problems.filter((p) => p.level === 'error').length, 0, 'example dataset is valid');
  const cases = await loadEvalCases(evalsDir);
  assert.ok(cases.length >= 4);
  const results = await runEvals(dataset, cases, { strategy: 'graph' });
  for (const r of results) {
    assert.ok(r.passedCitations, `${r.name}: missing ${r.missingCitations.join(', ')}`);
    assert.ok(r.withinBudget, `${r.name}: over budget (${r.tokensAfter})`);
  }
});

test('flat baseline fails the retrieval-tier traps (false attribution, aggregate reversal)', async () => {
  const { dataset } = await loadDataset(dataPath);
  const cases = await loadEvalCases(evalsDir);
  const results = await runEvals(dataset, cases, { strategy: 'flat' });
  const byName = new Map(results.map((r) => [r.name, r]));
  const trap1 = byName.get('false-attribution-welcome-v2')!;
  const trap2 = byName.get('aggregate-reversal-pricing-lp')!;
  assert.equal(trap1.passedCitations, false, 'flat retrieval must miss the sibling executions');
  assert.ok(trap1.missingCitations.includes('exec_q2_reactivation'));
  assert.equal(trap2.passedCitations, false, 'flat retrieval must miss the per-audience evidence');
});
