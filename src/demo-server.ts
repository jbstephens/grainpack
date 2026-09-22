import * as http from 'node:http';
import { citedIds, generateAnswer, hasApiKey } from './answer.js';
import { entityLabel, neighbors } from './dataset.js';
import { DEMO_HTML } from './demo-page.js';
import { packContext } from './pack.js';
import type { Dataset, EvalCase, Mode, Strategy } from './types.js';
import { VERSION } from './version.js';

export interface DemoServerOptions {
  port?: number;
  suggestedQuestions?: string[];
  log?: (msg: string) => void;
}

export function createDemoServer(ds: Dataset, evalCases: EvalCase[], opts: DemoServerOptions = {}): http.Server {
  const suggested =
    opts.suggestedQuestions ??
    (evalCases.length > 0
      ? evalCases.slice(0, 4).map((c) => c.question)
      : ['What stands out in this dataset?']);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status: number, body: unknown, type = 'application/json') => {
      const payload = type === 'application/json' ? JSON.stringify(body) : String(body);
      res.writeHead(status, { 'content-type': type + '; charset=utf-8' });
      res.end(payload);
    };
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        return send(200, DEMO_HTML, 'text/html');
      }
      if (req.method === 'GET' && url.pathname === '/api/overview') {
        const typeCounts: Record<string, number> = {};
        for (const [type, list] of ds.byType.entries()) typeCounts[type] = list.length;
        return send(200, {
          version: VERSION,
          name: ds.name,
          records: ds.entities.size,
          edges: ds.edgeCount,
          tokensEstimate: ds.tokensEstimate,
          typeCounts,
          relationships: ds.schema.relationships,
          suggestedQuestions: suggested,
          hasApiKey: hasApiKey(),
        });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/entity/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/entity/'.length));
        const e = ds.entities.get(id);
        if (!e) return send(404, { error: `no entity "${id}"` });
        return send(200, {
          entity: e,
          label: entityLabel(ds, e),
          neighbors: neighbors(ds, id).map((n) => ({
            ...n,
            label: entityLabel(ds, ds.entities.get(n.other)!),
            type: ds.entities.get(n.other)!.type,
          })),
        });
      }
      if (req.method === 'POST' && (url.pathname === '/api/pack' || url.pathname === '/api/ask')) {
        const body = await readBody(req);
        const question = String(body.question ?? '').slice(0, 2000);
        if (!question.trim()) return send(400, { error: 'question is required' });
        const mode = (['broad', 'balanced', 'aggressive'] as Mode[]).includes(body.mode as Mode)
          ? (body.mode as Mode)
          : 'balanced';
        const strategy: Strategy = body.strategy === 'flat' ? 'flat' : 'graph';
        const pkg = packContext(ds, question, { mode, strategy });
        // Labels for display without shipping full records
        const labels: Record<string, string> = {};
        for (const s of [...pkg.selected, ...pkg.excluded.slice(0, 200)]) {
          const e = ds.entities.get(s.id);
          if (e) labels[s.id] = entityLabel(ds, e);
        }
        for (const s of pkg.seeds) {
          const e = ds.entities.get(s.id);
          if (e) labels[s.id] = entityLabel(ds, e);
        }
        if (url.pathname === '/api/pack') return send(200, { package: pkg, labels });
        if (!hasApiKey()) return send(200, { package: pkg, labels, answer: null, note: 'ANTHROPIC_API_KEY not set — showing the packed context only.' });
        opts.log?.(`answering (${strategy}/${mode}): ${question}`);
        const answer = await generateAnswer(pkg);
        return send(200, { package: pkg, labels, answer, cited: citedIds(answer, pkg) });
      }
      send(404, { error: 'not found' });
    } catch (err) {
      send(500, { error: (err as Error).message });
    }
  });
  return server;
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}
