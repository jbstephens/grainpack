import { entityLabel } from './dataset.js';
import type { Dataset, Entity, SelectedRecord } from './types.js';
import { truncateText } from './util.js';

/** Compact single-record rendering: `[id] Label — field: value; …` */
export function renderRecord(ds: Dataset, e: Entity, textTrunc: number): string {
  const def = ds.schema.entities[e.type];
  const label = entityLabel(ds, e);
  const parts: string[] = [];
  const seen = new Set<string>([def?.label ?? '']);
  const order = [...(def?.summary ?? []), ...Object.keys(e.fields)];
  for (const key of order) {
    if (seen.has(key) || !(key in e.fields)) continue;
    seen.add(key);
    const v = e.fields[key];
    if (v === null || v === undefined) continue;
    const rendered =
      typeof v === 'string' ? truncateText(v, textTrunc) : typeof v === 'object' ? truncateText(JSON.stringify(v), textTrunc) : String(v);
    parts.push(`${key}: ${rendered}`);
  }
  return `[${e.id}] ${label}${parts.length ? ' — ' + parts.join('; ') : ''}`;
}

/**
 * Render the full evidence block: grain notes, records grouped by type, the
 * relationship links among selected records, and the answering rules.
 * Deterministic: same selection in, same prompt out.
 */
export function renderPrompt(
  ds: Dataset,
  question: string,
  selected: SelectedRecord[],
  textTrunc: number
): string {
  const lines: string[] = [];
  lines.push(`# Question`, question, '');
  lines.push(`# Data grain`);
  lines.push(
    `Records below are drawn from a structured dataset. Each fact belongs to the specific record it appears on — do not generalize a value from one record to related records at a different grain.`
  );
  for (const [name, rel] of Object.entries(ds.schema.relationships).sort(([a], [b]) => (a < b ? -1 : 1))) {
    lines.push(`- ${name}: ${rel.from} -> ${rel.to}`);
  }
  lines.push('');

  const byType = new Map<string, SelectedRecord[]>();
  for (const s of selected) {
    let list = byType.get(s.type);
    if (!list) byType.set(s.type, (list = []));
    list.push(s);
  }
  lines.push(`# Evidence (${selected.length} records)`);
  for (const [type, records] of [...byType.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    lines.push('', `## ${type} (${records.length})`);
    for (const r of [...records].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const e = ds.entities.get(r.id);
      if (e) lines.push(renderRecord(ds, e, textTrunc));
    }
  }

  const selectedIds = new Set(selected.map((s) => s.id));
  const links: string[] = [];
  for (const id of [...selectedIds].sort()) {
    for (const { edge, to } of ds.out.get(id) ?? []) {
      if (selectedIds.has(to)) links.push(`${id} -${edge}-> ${to}`);
    }
  }
  if (links.length > 0) {
    lines.push('', `# Relationships among these records`);
    lines.push(...links);
  }

  lines.push(
    '',
    `# Answering rules`,
    `- Answer the question using ONLY the evidence above.`,
    `- Cite record ids in [brackets] for every factual claim.`,
    `- Distinguish observed data from inference; label inferences as such.`,
    `- If the evidence is insufficient or cuts against a simple answer, say so plainly.`,
    `- Do not invent records, metrics, or entities that are not present above.`
  );
  return lines.join('\n');
}
