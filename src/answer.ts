import type { ContextPackage, EvalCase, JudgedResult } from './types.js';

export interface AnswerOptions {
  model?: string;
  maxTokens?: number;
  /** Called with each streamed text delta (for live CLI output). */
  onText?: (text: string) => void;
}

const DEFAULT_MODEL = 'claude-opus-5';

const SYSTEM_PROMPT = [
  'You are answering a question about structured business data.',
  'You will receive an evidence block with records, their ids, and the relationships among them.',
  'Follow the answering rules at the end of the evidence block exactly:',
  'use only the provided evidence, cite record ids in [brackets] for every factual claim,',
  'label inference as inference, and say plainly when the evidence does not support a confident answer.',
].join(' ');

export function hasApiKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

async function getClient() {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  return new Anthropic();
}

/** Send only the packed context to the model; return the grounded answer text. */
export async function generateAnswer(pkg: ContextPackage, opts: AnswerOptions = {}): Promise<string> {
  const client = await getClient();
  const stream = client.beta.messages.stream({
    model: opts.model ?? DEFAULT_MODEL,
    max_tokens: opts.maxTokens ?? 16000,
    // Server-side refusal fallback: reroutes the rare safety-classifier
    // refusal to a fallback model instead of failing the request.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: pkg.prompt }],
  } as never);
  if (opts.onText) stream.on('text', opts.onText);
  const message = await stream.finalMessage();
  if (message.stop_reason === 'refusal') {
    throw new Error('The model declined to answer this request.');
  }
  return message.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
}

/** Record ids the answer actually cited, as [id] references. */
export function citedIds(answer: string, pkg: ContextPackage): string[] {
  const selectedIds = new Set(pkg.selected.map((s) => s.id));
  const cited = new Set<string>();
  for (const m of answer.matchAll(/\[([A-Za-z0-9_.:@+-]+)\]/g)) {
    if (selectedIds.has(m[1])) cited.add(m[1]);
  }
  return [...cited].sort();
}

/**
 * Model-assessed check of an answer against an eval case's mustNotConclude /
 * shouldSurface expectations. Results are labeled as judged, never merged
 * silently with deterministic checks.
 */
export async function judgeAnswer(answer: string, evalCase: EvalCase, opts: AnswerOptions = {}): Promise<JudgedResult> {
  const client = await getClient();
  const prompt = [
    'You are grading an AI-generated answer against expectations. Reply with ONLY a JSON object:',
    '{"violations": [list of forbidden conclusions the answer effectively asserts], "surfaced": true|false|null, "notes": "one sentence"}',
    '',
    `FORBIDDEN CONCLUSIONS (a violation only if the answer asserts it as a supported conclusion, not if it mentions and rejects it):`,
    ...(evalCase.mustNotConclude ?? []).map((c) => `- ${c}`),
    '',
    evalCase.shouldSurface
      ? `THE ANSWER SHOULD SURFACE: ${evalCase.shouldSurface}\nSet "surfaced" to true or false accordingly.`
      : 'No surfacing expectation; set "surfaced" to null.',
    '',
    'ANSWER TO GRADE:',
    answer,
  ].join('\n');
  const stream = client.beta.messages.stream({
    model: opts.model ?? DEFAULT_MODEL,
    max_tokens: 2000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    messages: [{ role: 'user', content: prompt }],
  } as never);
  const message = await stream.finalMessage();
  const text = message.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  let parsed: { violations?: string[]; surfaced?: boolean | null; notes?: string } = {};
  try {
    parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
  } catch {
    return { passed: false, violations: [], surfaced: null, notes: `judge response was not parseable: ${text.slice(0, 120)}` };
  }
  const violations = Array.isArray(parsed.violations) ? parsed.violations.map(String) : [];
  const surfaced = typeof parsed.surfaced === 'boolean' ? parsed.surfaced : null;
  const passed = violations.length === 0 && (evalCase.shouldSurface ? surfaced === true : true);
  return { passed, violations, surfaced, notes: String(parsed.notes ?? '') };
}
