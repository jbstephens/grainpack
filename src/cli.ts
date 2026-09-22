#!/usr/bin/env node
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { citedIds, generateAnswer, hasApiKey } from './answer.js';
import { entityLabel, loadDataset, neighbors } from './dataset.js';
import { createDemoServer } from './demo-server.js';
import { evalPassed, loadEvalCases, runEvals } from './evalrunner.js';
import { runIngest } from './ingest.js';
import { packContext } from './pack.js';
import type { EvalCase, MappingConfig, Mode, Strategy } from './types.js';
import { VERSION } from './version.js';

const HELP = `grainpack ${VERSION} — relationship-aware context packing for structured data

Usage:
  grainpack <command> [options]

Commands:
  ingest     Map CSV/JSON/JSONL sources into a dataset      (--map, --out)
  validate   Check a dataset against its schema; print stats
  inspect    Show one entity and its neighborhood           (--id)
  pack       Question -> context package JSON               (--question)
  ask        pack + send to Claude, print grounded answer   [needs ANTHROPIC_API_KEY]
  eval       Run eval cases against a strategy              (--evals, --strategy)
  demo       Serve the interactive demo locally             (--port)

Common options:
  --data <file|dir>        dataset.json, or a dir with schema.json + *.jsonl
                           (default: the bundled examples/marketing dataset)
  --question "<q>"         the natural-language question (pack/ask)
  --mode <m>               broad | balanced (default) | aggressive
  --budget <tokens>        override the mode's token budget
  --strategy <s>           graph (default) | flat  — flat is the no-traversal
                           lexical baseline, for comparison
  --out <file>             write output to a file instead of stdout
  --model <id>             model for ask/eval answers (default claude-opus-5)
  --evals <dir>            directory of eval case JSON files
  --judge                  eval: also generate + judge answers (needs API key)
  --id <entity-id>         inspect: the entity to show
  --map <file>             ingest: mapping config JSON
  --port <n>               demo: port (default 4680)
  -h, --help               show this help
  -V, --version            show version

Exit codes: 0 ok · 1 fatal · 2 dataset validation errors · 3 eval failures

Examples:
  grainpack demo
  grainpack pack --question "What drove the Q3 onboarding conversion lift?"
  grainpack pack --question "..." --strategy flat        # watch the baseline miss
  grainpack eval --evals examples/marketing/evals --strategy flat
  grainpack ingest --map mapping.json --out dataset.json
`;

const logErr = (msg: string) => process.stderr.write(msg + '\n');

function fail(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

async function findDefaultData(): Promise<string> {
  // The bundled example dataset, resolved relative to the installed package.
  const here = path.dirname(new URL(import.meta.url).pathname);
  const candidates = [
    path.resolve(here, '../../examples/marketing/dataset.json'),
    path.resolve(process.cwd(), 'examples/marketing/dataset.json'),
    path.resolve(process.cwd(), 'dataset.json'),
  ];
  for (const c of candidates) {
    try {
      await fs.access(c);
      return c;
    } catch {
      /* keep looking */
    }
  }
  fail('no dataset found — pass --data <file|dir> (or run from a directory containing dataset.json)');
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      data: { type: 'string' },
      question: { type: 'string' },
      mode: { type: 'string', default: 'balanced' },
      budget: { type: 'string' },
      strategy: { type: 'string', default: 'graph' },
      out: { type: 'string' },
      model: { type: 'string' },
      evals: { type: 'string' },
      judge: { type: 'boolean', default: false },
      id: { type: 'string' },
      map: { type: 'string' },
      port: { type: 'string', default: '4680' },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'V', default: false },
    },
  });

  if (values.version) return void console.log(VERSION);
  const command = positionals[0];
  if (values.help || !command) {
    console.log(HELP);
    if (!command && !values.help) process.exit(1);
    return;
  }

  const mode = String(values.mode) as Mode;
  if (!['broad', 'balanced', 'aggressive'].includes(mode)) fail(`--mode must be broad, balanced, or aggressive`);
  const strategy = String(values.strategy) as Strategy;
  if (!['graph', 'flat'].includes(strategy)) fail(`--strategy must be graph or flat`);
  const budget = values.budget ? Number(values.budget) : undefined;
  if (budget !== undefined && (!Number.isInteger(budget) || budget < 500)) fail('--budget must be an integer >= 500');

  if (command === 'ingest') {
    if (!values.map) fail('ingest requires --map <mapping.json>');
    const mapPath = path.resolve(String(values.map));
    const config = JSON.parse(await fs.readFile(mapPath, 'utf8')) as MappingConfig;
    const { dataset, report } = await runIngest(config, path.dirname(mapPath));
    for (const s of report.sources) {
      logErr(`${s.file}: ${s.rowsRead} rows -> ${s.entitiesCreated} ${s.entity} entities, ${s.edgesCreated} edges` +
        (s.orphanedReferences ? ` (${s.orphanedReferences} orphaned references)` : ''));
    }
    for (const p of report.problems) logErr(`${p.level}: ${p.message}`);
    const json = JSON.stringify(dataset, null, 2);
    if (values.out) {
      await fs.writeFile(String(values.out), json);
      logErr(`wrote ${String(values.out)} (${dataset.entities.length} entities, ${dataset.edges.length} edges)`);
    } else console.log(json);
    return;
  }

  const dataPath = values.data ? path.resolve(String(values.data)) : await findDefaultData();
  logErr(`loading ${dataPath}…`);
  const { dataset: ds, problems } = await loadDataset(dataPath);
  const errors = problems.filter((p) => p.level === 'error');
  for (const p of problems.slice(0, 20)) logErr(`${p.level}: ${p.message}`);
  if (problems.length > 20) logErr(`…and ${problems.length - 20} more problems`);

  if (command === 'validate') {
    console.log(`dataset: ${ds.name}`);
    console.log(`entities: ${ds.entities.size}  edges: ${ds.edgeCount}  est. tokens: ${ds.tokensEstimate}`);
    for (const [type, list] of [...ds.byType.entries()].sort()) console.log(`  ${type}: ${list.length}`);
    console.log(`problems: ${errors.length} error(s), ${problems.length - errors.length} warning(s)`);
    if (errors.length > 0) process.exit(2);
    return;
  }
  if (errors.length > 0) logErr(`warning: dataset has ${errors.length} validation error(s) — run "grainpack validate"`);

  if (command === 'inspect') {
    if (!values.id) fail('inspect requires --id <entity-id>');
    const e = ds.entities.get(String(values.id));
    if (!e) fail(`no entity "${String(values.id)}"`);
    console.log(JSON.stringify({ entity: e, label: entityLabel(ds, e), neighbors: neighbors(ds, e.id) }, null, 2));
    return;
  }

  if (command === 'pack' || command === 'ask') {
    if (!values.question) fail(`${command} requires --question "<q>"`);
    const pkg = packContext(ds, String(values.question), { mode, budgetTokens: budget, strategy });
    logErr(
      `packed ${pkg.stats.selected}/${pkg.stats.considered} considered records — ~${pkg.stats.tokensAfter} tokens ` +
        `(dataset ~${ds.tokensEstimate}, −${pkg.stats.reductionPct}%)`
    );
    if (command === 'pack') {
      const json = JSON.stringify(pkg, null, 2);
      if (values.out) await fs.writeFile(String(values.out), json);
      else console.log(json);
      return;
    }
    if (!hasApiKey()) fail('ask requires ANTHROPIC_API_KEY (use "pack" for the keyless pipeline)');
    logErr('asking the model…\n');
    const answer = await generateAnswer(pkg, {
      model: values.model ? String(values.model) : undefined,
      onText: (t) => process.stdout.write(t),
    });
    process.stdout.write('\n');
    logErr(`\ncited: ${citedIds(answer, pkg).join(', ') || '(no record ids cited)'}`);
    if (values.out) {
      await fs.writeFile(String(values.out), JSON.stringify({ package: pkg, answer }, null, 2));
      logErr(`wrote ${String(values.out)}`);
    }
    return;
  }

  if (command === 'eval') {
    const evalsDir = values.evals
      ? path.resolve(String(values.evals))
      : path.join(path.dirname(dataPath), 'evals');
    const cases: EvalCase[] = await loadEvalCases(evalsDir).catch(() => fail(`no eval cases found at ${evalsDir} — pass --evals <dir>`));
    const results = await runEvals(ds, cases, {
      strategy,
      judge: Boolean(values.judge),
      model: values.model ? String(values.model) : undefined,
      log: logErr,
    });
    let failed = 0;
    for (const r of results) {
      const ok = evalPassed(r);
      if (!ok) failed++;
      const bits = [
        r.passedCitations ? 'citations ok' : `MISSING: ${r.missingCitations.join(', ')}`,
        r.withinBudget ? `${r.tokensAfter} tok` : `OVER BUDGET (${r.tokensAfter} tok)`,
      ];
      if (r.judged) bits.push(r.judged.passed ? 'judge ok' : `JUDGE: ${r.judged.violations.join('; ') || r.judged.notes}`);
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.name} [${r.strategy}]  ${bits.join('  ·  ')}`);
    }
    console.log(`\n${results.length - failed}/${results.length} passed (strategy: ${strategy})`);
    if (failed > 0) process.exit(3);
    return;
  }

  if (command === 'demo') {
    const port = Number(values.port);
    const evalsDir = values.evals ? path.resolve(String(values.evals)) : path.join(path.dirname(dataPath), 'evals');
    const cases = await loadEvalCases(evalsDir).catch(() => [] as EvalCase[]);
    const server = createDemoServer(ds, cases, { log: logErr });
    server.listen(port, () => {
      logErr(`grainpack demo: http://localhost:${port}`);
      logErr(hasApiKey() ? 'API key detected — answers enabled.' : 'No ANTHROPIC_API_KEY — retrieval-only mode (packages + prompts, no answers).');
    });
    return;
  }

  fail(`unknown command "${command}"\n\n${HELP}`);
}

main().catch((err: Error) => {
  process.stderr.write(`error: ${err.message}\n`);
  process.exit(1);
});
