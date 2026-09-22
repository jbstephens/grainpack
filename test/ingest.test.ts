import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseCsv, runIngest } from '../src/ingest.js';
import { indexDataset } from '../src/dataset.js';
import type { MappingConfig } from '../src/types.js';

test('parseCsv handles quotes, escaped quotes, commas and newlines in fields', () => {
  const rows = parseCsv('id,name,notes\r\n1,"Smith, Jane","She said ""hi""\nand left"\n2,Bob,plain\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'Smith, Jane');
  assert.equal(rows[0].notes, 'She said "hi"\nand left');
  assert.equal(rows[1].name, 'Bob');
});

test('runIngest maps sources to entities and edges, reports orphans', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'grainpack-ingest-'));
  await fs.writeFile(path.join(dir, 'campaigns.csv'), 'campaign_id,name\nc1,Spring Launch\nc2,Fall Launch\n');
  await fs.writeFile(
    path.join(dir, 'sends.csv'),
    'send_id,name,campaign_id,rate\ns1,Send One,c1,0.05\ns2,Send Two,c2,0.03\ns3,Orphan Send,c9,0.01\n'
  );
  const config: MappingConfig = {
    formatVersion: 1,
    name: 'mapped',
    schema: {
      entities: { campaign: { label: 'name' }, send: { label: 'name' } },
      relationships: { has_send: { from: 'campaign', to: 'send' } },
    },
    sources: [
      { file: 'campaigns.csv', entity: 'campaign', id: 'campaign_id' },
      {
        file: 'sends.csv',
        entity: 'send',
        id: 'send_id',
        edges: [{ type: 'has_send', from: { column: 'campaign_id' } }],
      },
    ],
  };
  const { dataset, report } = await runIngest(config, dir);
  assert.equal(dataset.entities.length, 5);
  assert.equal(dataset.edges.length, 2, 'orphan edge dropped');
  const sends = report.sources.find((s) => s.file === 'sends.csv')!;
  assert.equal(sends.orphanedReferences, 1, 'orphan is counted, not silent');
  assert.ok(report.problems.some((p) => p.message.includes('orphaned')));
  // Numeric-looking CSV strings are coerced so salience can work downstream
  const s1 = dataset.entities.find((e) => e.id === 's1')!;
  assert.equal(s1.fields.rate, 0.05);
  // The mapped output indexes cleanly
  const { problems } = indexDataset(dataset);
  assert.equal(problems.filter((p) => p.level === 'error').length, 0);
});
