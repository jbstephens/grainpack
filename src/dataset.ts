import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  Dataset,
  DatasetFile,
  Edge,
  Entity,
  EntityTypeDef,
  ValidationProblem,
} from './types.js';
import { estimateTokens, tokenize } from './util.js';

/** Load a dataset from dataset.json, or a directory of schema.json + entities.jsonl + edges.jsonl. */
export async function loadDataset(target: string): Promise<{ dataset: Dataset; problems: ValidationProblem[] }> {
  const stat = await fs.stat(target);
  let file: DatasetFile;
  if (stat.isDirectory()) {
    const schema = JSON.parse(await fs.readFile(path.join(target, 'schema.json'), 'utf8'));
    const entities = await readJsonl<Entity>(path.join(target, 'entities.jsonl'));
    const edges = await readJsonl<Edge>(path.join(target, 'edges.jsonl'));
    file = { formatVersion: 1, name: schema.name ?? path.basename(target), schema: schema.schema ?? schema, entities, edges };
  } else {
    file = JSON.parse(await fs.readFile(target, 'utf8'));
  }
  return indexDataset(file);
}

async function readJsonl<T>(file: string): Promise<T[]> {
  const text = await fs.readFile(file, 'utf8');
  return text
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as T);
}

/** Validate and index an in-memory dataset file. Never throws on data problems — reports them. */
export function indexDataset(file: DatasetFile): { dataset: Dataset; problems: ValidationProblem[] } {
  const problems: ValidationProblem[] = [];
  if (file.formatVersion !== 1) {
    problems.push({ level: 'warning', message: `unknown formatVersion ${String(file.formatVersion)} — parsed as version 1` });
  }
  const schema = file.schema ?? { entities: {}, relationships: {} };

  const entities = new Map<string, Entity>();
  const byType = new Map<string, Entity[]>();
  for (const e of file.entities ?? []) {
    if (!e?.id || !e.type) {
      problems.push({ level: 'error', message: `entity missing id or type: ${JSON.stringify(e).slice(0, 80)}` });
      continue;
    }
    if (entities.has(e.id)) {
      problems.push({ level: 'error', message: `duplicate entity id "${e.id}"` });
      continue;
    }
    if (!schema.entities[e.type]) {
      problems.push({ level: 'warning', message: `entity "${e.id}" has undeclared type "${e.type}"` });
    }
    const rec: Entity = { id: e.id, type: e.type, fields: e.fields ?? {} };
    entities.set(e.id, rec);
    let list = byType.get(e.type);
    if (!list) byType.set(e.type, (list = []));
    list.push(rec);
  }

  const out = new Map<string, Array<{ edge: string; to: string }>>();
  const inn = new Map<string, Array<{ edge: string; from: string }>>();
  let edgeCount = 0;
  for (const edge of file.edges ?? []) {
    if (!edge?.type || !edge.from || !edge.to) {
      problems.push({ level: 'error', message: `malformed edge: ${JSON.stringify(edge).slice(0, 80)}` });
      continue;
    }
    const rel = schema.relationships[edge.type];
    const src = entities.get(edge.from);
    const dst = entities.get(edge.to);
    if (!src || !dst) {
      problems.push({ level: 'error', message: `edge ${edge.type} ${edge.from} -> ${edge.to} references a missing entity` });
      continue;
    }
    if (!rel) {
      problems.push({ level: 'warning', message: `edge type "${edge.type}" is not declared in schema.relationships` });
    } else {
      if (src.type !== rel.from) problems.push({ level: 'warning', message: `edge ${edge.type}: "${edge.from}" is ${src.type}, schema expects ${rel.from}` });
      if (dst.type !== rel.to) problems.push({ level: 'warning', message: `edge ${edge.type}: "${edge.to}" is ${dst.type}, schema expects ${rel.to}` });
    }
    let o = out.get(edge.from);
    if (!o) out.set(edge.from, (o = []));
    o.push({ edge: edge.type, to: edge.to });
    let i = inn.get(edge.to);
    if (!i) inn.set(edge.to, (i = []));
    i.push({ edge: edge.type, from: edge.from });
    edgeCount++;
  }

  // Deterministic neighbor ordering
  for (const list of out.values()) list.sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
  for (const list of inn.values()) list.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));

  const tokenIndex = new Map<string, Set<string>>();
  const entityTokens = new Map<string, Set<string>>();
  let tokensEstimate = 0;
  for (const e of entities.values()) {
    const toks = new Set<string>();
    for (const [key, value] of Object.entries(e.fields)) {
      if (typeof value === 'string') {
        for (const t of tokenize(value)) toks.add(t);
        tokensEstimate += estimateTokens(`${key}: ${value}; `);
      } else {
        tokensEstimate += estimateTokens(`${key}: ${String(value)}; `);
      }
    }
    tokensEstimate += estimateTokens(e.id) + 4;
    entityTokens.set(e.id, toks);
    for (const t of toks) {
      let set = tokenIndex.get(t);
      if (!set) tokenIndex.set(t, (set = new Set()));
      set.add(e.id);
    }
  }

  const dataset: Dataset = {
    name: file.name ?? 'dataset',
    schema,
    entities,
    byType,
    out,
    in: inn,
    tokenIndex,
    entityTokens,
    edgeCount,
    tokensEstimate,
  };
  return { dataset, problems };
}

export function entityLabel(ds: Dataset, e: Entity): string {
  const def: EntityTypeDef | undefined = ds.schema.entities[e.type];
  const labelField = def?.label;
  const v = labelField ? e.fields[labelField] : undefined;
  return typeof v === 'string' && v.length > 0 ? v : e.id;
}

/** Every neighbor (in + out) of an entity, deterministic order. */
export function neighbors(ds: Dataset, id: string): Array<{ edge: string; other: string; direction: 'out' | 'in' }> {
  const res: Array<{ edge: string; other: string; direction: 'out' | 'in' }> = [];
  for (const { edge, to } of ds.out.get(id) ?? []) res.push({ edge, other: to, direction: 'out' });
  for (const { edge, from } of ds.in.get(id) ?? []) res.push({ edge, other: from, direction: 'in' });
  return res;
}
