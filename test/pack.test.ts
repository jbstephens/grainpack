import test from 'node:test';
import assert from 'node:assert/strict';
import { indexDataset } from '../src/dataset.js';
import { packContext } from '../src/pack.js';
import { detectComparison, resolveSeeds } from '../src/resolve.js';
import { traverse } from '../src/traverse.js';
import type { DatasetFile } from '../src/types.js';

/**
 * Small fixture graph: two projects share a template; one task has an
 * outlier score. Enough structure to exercise resolution, traversal,
 * sibling expansion, salience, and packing.
 */
const FILE: DatasetFile = {
  formatVersion: 1,
  name: 'projects',
  schema: {
    entities: {
      project: { label: 'name', aliases: ['projects'] },
      template: { label: 'name' },
      task: { label: 'name' },
      score: { label: 'name', salience: { valueField: 'value', groupBy: 'kind' } },
    },
    relationships: {
      uses_template: { from: 'project', to: 'template' },
      has_task: { from: 'project', to: 'task' },
      scored_by: { from: 'task', to: 'score' },
    },
  },
  entities: [
    { id: 'p1', type: 'project', fields: { name: 'Apollo Migration' } },
    { id: 'p2', type: 'project', fields: { name: 'Zephyr Migration' } },
    { id: 'p3', type: 'project', fields: { name: 'Unrelated Thing' } },
    { id: 'tpl1', type: 'template', fields: { name: 'Migration Template' } },
    { id: 't1', type: 'task', fields: { name: 'Apollo cutover task' } },
    { id: 't2', type: 'task', fields: { name: 'Zephyr cutover task' } },
    { id: 't3', type: 'task', fields: { name: 'Unrelated task' } },
    { id: 's1', type: 'score', fields: { name: 'Quality — Apollo', kind: 'quality', value: 0.9 } },
    { id: 's2', type: 'score', fields: { name: 'Quality — Zephyr', kind: 'quality', value: 0.4 } },
    { id: 's3', type: 'score', fields: { name: 'Quality — Unrelated', kind: 'quality', value: 0.45 } },
  ],
  edges: [
    { type: 'uses_template', from: 'p1', to: 'tpl1' },
    { type: 'uses_template', from: 'p2', to: 'tpl1' },
    { type: 'has_task', from: 'p1', to: 't1' },
    { type: 'has_task', from: 'p2', to: 't2' },
    { type: 'has_task', from: 'p3', to: 't3' },
    { type: 'scored_by', from: 't1', to: 's1' },
    { type: 'scored_by', from: 't2', to: 's2' },
    { type: 'scored_by', from: 't3', to: 's3' },
  ],
};

const ds = indexDataset(FILE).dataset;

test('resolves the named entity as the top seed', () => {
  const seeds = resolveSeeds(ds, 'How did the Apollo Migration go?');
  assert.equal(seeds[0].id, 'p1');
});

test('comparison questions are detected', () => {
  assert.equal(detectComparison('Compare Apollo vs Zephyr'), true);
  assert.equal(detectComparison('How did Apollo go?'), false);
});

test('traversal walks relationships and reaches the co-template project', () => {
  const seeds = resolveSeeds(ds, 'How did the Apollo Migration go?');
  const cands = traverse(ds, seeds);
  assert.ok(cands.has('t1'), 'own task via has_task');
  assert.ok(cands.has('s1'), 'own score two hops out');
  assert.ok(cands.has('p2'), 'co-template project reached');
  assert.ok(cands.has('t2'), "sibling's task rides along");
  assert.ok(!cands.has('p3'), 'unconnected project is not reached');
});

test('with depth 1, sibling expansion still finds comparables through shared nodes', () => {
  const seeds = resolveSeeds(ds, 'How did the Apollo Migration go?');
  const cands = traverse(ds, seeds, { depth: 1 });
  const p2 = cands.get('p2');
  assert.equal(p2?.reason, 'sibling');
  assert.equal(p2?.via[0].sharedNeighbor, 'tpl1', 'sibling provenance names the shared node');
  assert.ok(cands.has('s2'), "sibling's salient score rides along");
});

test('packContext produces a grounded package with provenance', () => {
  const pkg = packContext(ds, 'How did the Apollo Migration go?');
  const ids = pkg.selected.map((s) => s.id);
  assert.ok(ids.includes('p1') && ids.includes('s1') && ids.includes('p2'));
  assert.ok(pkg.prompt.includes('[p1]'), 'prompt renders record ids');
  assert.ok(pkg.prompt.includes('p1 -has_task-> t1'), 'prompt includes relationship links');
  assert.ok(pkg.prompt.includes('Answering rules'));
  assert.ok(pkg.stats.tokensAfter <= pkg.budgetTokens);
});

test('packing is deterministic', () => {
  const a = packContext(ds, 'Compare Apollo Migration and Zephyr Migration quality');
  const b = packContext(ds, 'Compare Apollo Migration and Zephyr Migration quality');
  assert.deepEqual(a, b);
});

test('budget excludes overflow records with reason "budget"', () => {
  const pkg = packContext(ds, 'How did the Apollo Migration go?', { budgetTokens: 500, mode: 'broad' });
  assert.ok(pkg.stats.tokensAfter <= 500);
  if (pkg.excluded.length > 0) {
    assert.ok(pkg.excluded.every((e) => ['budget', 'low-score', 'redundant'].includes(e.reason)));
  }
});

test('flat strategy ranks lexically with no seeds or traversal', () => {
  const pkg = packContext(ds, 'Apollo quality', { strategy: 'flat' });
  assert.equal(pkg.seeds.length, 0);
  assert.ok(pkg.selected.every((s) => s.reason === 'lexical' && s.via.length === 0));
});
