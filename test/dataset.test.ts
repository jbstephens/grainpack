import test from 'node:test';
import assert from 'node:assert/strict';
import { entityLabel, indexDataset, neighbors } from '../src/dataset.js';
import type { DatasetFile } from '../src/types.js';

const FILE: DatasetFile = {
  formatVersion: 1,
  name: 'fixture',
  schema: {
    entities: { a: { label: 'name' }, b: { label: 'name' } },
    relationships: { has: { from: 'a', to: 'b' } },
  },
  entities: [
    { id: 'a1', type: 'a', fields: { name: 'Alpha One' } },
    { id: 'b1', type: 'b', fields: { name: 'Beta One' } },
    { id: 'b2', type: 'b', fields: { name: 'Beta Two' } },
  ],
  edges: [
    { type: 'has', from: 'a1', to: 'b2' },
    { type: 'has', from: 'a1', to: 'b1' },
  ],
};

test('indexes entities, edges, and tokens', () => {
  const { dataset, problems } = indexDataset(FILE);
  assert.equal(problems.length, 0);
  assert.equal(dataset.entities.size, 3);
  assert.equal(dataset.edgeCount, 2);
  assert.equal(entityLabel(dataset, dataset.entities.get('a1')!), 'Alpha One');
  assert.ok(dataset.tokenIndex.get('beta')?.has('b1'));
  // Deterministic neighbor ordering by id
  assert.deepEqual(
    neighbors(dataset, 'a1').map((n) => n.other),
    ['b1', 'b2']
  );
});

test('reports duplicate ids, missing endpoints, and type mismatches', () => {
  const { problems } = indexDataset({
    ...FILE,
    entities: [...FILE.entities, { id: 'a1', type: 'a', fields: {} }],
    edges: [
      ...FILE.edges,
      { type: 'has', from: 'a1', to: 'ghost' },
      { type: 'has', from: 'b1', to: 'b2' },
    ],
  });
  const messages = problems.map((p) => p.message).join('\n');
  assert.match(messages, /duplicate entity id "a1"/);
  assert.match(messages, /missing entity/);
  assert.match(messages, /schema expects a/);
});

test('unknown formatVersion warns but still parses', () => {
  const { dataset, problems } = indexDataset({ ...FILE, formatVersion: 99 as unknown as 1 });
  assert.equal(dataset.entities.size, 3);
  assert.ok(problems.some((p) => p.message.includes('formatVersion')));
});
