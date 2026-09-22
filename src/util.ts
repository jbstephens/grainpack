const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'for', 'to', 'is', 'are',
  'was', 'were', 'did', 'do', 'does', 'why', 'what', 'which', 'how', 'we',
  'our', 'should', 'with', 'that', 'this', 'it', 'its', 'at', 'by', 'from',
  'as', 'be', 'can', 'will', 'my', 'your', 'their', 'have', 'has', 'had',
]);

/** Lowercase, split on non-alphanumerics, drop stopwords, fold simple plurals. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (let raw of String(text).toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    if (raw.length > 3 && raw.endsWith('s') && !raw.endsWith('ss')) raw = raw.slice(0, -1);
    out.push(raw);
  }
  return out;
}

/** Honest estimate, labeled as such wherever it surfaces: ~4 chars per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function truncateText(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

/** Deterministic comparator: score descending, then id ascending. */
export function byScoreThenId<T extends { score: number; id: string }>(a: T, b: T): number {
  if (b.score !== a.score) return b.score - a.score;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length;
}

export function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
}
