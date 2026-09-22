import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { DatasetFile, Edge, Entity, IngestReport, MappingConfig } from './types.js';

/** RFC-4180-ish CSV parser: quoted fields, escaped quotes, newlines in quotes. */
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  if (rows.length === 0) return [];
  const header = rows[0];
  return rows.slice(1).map((r) => {
    const rec: Record<string, string> = {};
    header.forEach((h, i) => (rec[h] = r[i] ?? ''));
    return rec;
  });
}

async function readRows(file: string): Promise<Array<Record<string, unknown>>> {
  const text = await fs.readFile(file, 'utf8');
  const ext = path.extname(file).toLowerCase();
  if (ext === '.csv') return parseCsv(text);
  if (ext === '.jsonl' || ext === '.ndjson') {
    return text
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error(`${file}: expected a JSON array of rows`);
  return parsed as Array<Record<string, unknown>>;
}

/** Coerce numeric-looking CSV strings so metrics behave as numbers downstream. */
function coerce(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  if (v === '') return v;
  const n = Number(v);
  return Number.isFinite(n) && /^-?\d+(\.\d+)?$/.test(v.trim()) ? n : v;
}

/**
 * Execute a mapping config over its sources, producing a dataset file plus an
 * ingest report. Nothing is silently dropped: orphaned foreign keys are
 * counted per source and reported.
 */
export async function runIngest(
  config: MappingConfig,
  baseDir: string
): Promise<{ dataset: DatasetFile; report: IngestReport }> {
  const entities: Entity[] = [];
  const edges: Edge[] = [];
  const report: IngestReport = { sources: [], problems: [] };
  const ids = new Set<string>();
  const pendingEdges: Array<{ edge: Edge; sourceFile: string }> = [];

  for (const src of config.sources) {
    const file = path.resolve(baseDir, src.file);
    const rows = await readRows(file);
    let created = 0;
    let edgeCount = 0;
    for (const row of rows) {
      const id = String(row[src.id] ?? '').trim();
      if (!id) {
        report.problems.push({ level: 'warning', message: `${src.file}: row missing id column "${src.id}" — skipped` });
        continue;
      }
      if (ids.has(id)) {
        report.problems.push({ level: 'warning', message: `${src.file}: duplicate id "${id}" — skipped` });
        continue;
      }
      ids.add(id);
      const fields: Record<string, unknown> = {};
      if (src.fields) {
        for (const [outField, column] of Object.entries(src.fields)) fields[outField] = coerce(row[column]);
      } else {
        for (const [k, v] of Object.entries(row)) {
          if (k === src.id) continue;
          fields[k] = coerce(v);
        }
      }
      entities.push({ id, type: src.entity, fields });
      created++;
      for (const edgeDef of src.edges ?? []) {
        const fromCol = edgeDef.from?.column;
        const toCol = edgeDef.to?.column;
        if (fromCol) {
          const other = String(row[fromCol] ?? '').trim();
          if (other) {
            pendingEdges.push({ edge: { type: edgeDef.type, from: other, to: id }, sourceFile: src.file });
            edgeCount++;
          }
        } else if (toCol) {
          const other = String(row[toCol] ?? '').trim();
          if (other) {
            pendingEdges.push({ edge: { type: edgeDef.type, from: id, to: other }, sourceFile: src.file });
            edgeCount++;
          }
        }
      }
    }
    report.sources.push({
      file: src.file,
      entity: src.entity,
      rowsRead: rows.length,
      entitiesCreated: created,
      edgesCreated: edgeCount,
      orphanedReferences: 0,
    });
  }

  // Resolve edges now that every source's ids are known.
  const orphansBySource = new Map<string, number>();
  for (const { edge, sourceFile } of pendingEdges) {
    if (ids.has(edge.from) && ids.has(edge.to)) edges.push(edge);
    else orphansBySource.set(sourceFile, (orphansBySource.get(sourceFile) ?? 0) + 1);
  }
  for (const s of report.sources) {
    s.orphanedReferences = orphansBySource.get(s.file) ?? 0;
    if (s.orphanedReferences > 0) {
      report.problems.push({
        level: 'warning',
        message: `${s.file}: ${s.orphanedReferences} orphaned edge reference(s) — ids not found in any source`,
      });
    }
  }

  const dataset: DatasetFile = {
    formatVersion: 1,
    name: config.name ?? 'ingested-dataset',
    schema: config.schema,
    entities,
    edges,
  };
  return { dataset, report };
}
