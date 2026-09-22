# grainpack

Relationship-aware context packing for structured data. Give grainpack a typed
entity graph and a question; it resolves the question to entities, traverses
your schema's **real relationships**, and packs a small, provenance-rich
context package for an LLM — so the model reasons over the right evidence at
the right **grain**, instead of a pile of keyword-similar records.

```bash
npx grainpack demo     # interactive demo on a bundled synthetic dataset
```

No vector database. No embeddings. No API key needed for the core pipeline.
One dependency (the Anthropic SDK), loaded only by the optional answer step.

## The problem grainpack exists for

Retrieval for LLM apps defaults to similarity: embed everything, fetch what
sounds related, hope the model sorts it out. For data that is *already
structured* — campaigns and executions, tickets and customers, orders and line
items — that throws away the most valuable signal the data has: its
relationships and its grain.

The failure mode isn't missing information; it's **misread** information.
In the bundled demo dataset, an email creative posts a 16% conversion rate in
one send. Keyword retrieval finds that number and produces a confident,
well-written recommendation to reuse the creative. The graph shows the same
asset converting at 2–4% everywhere else — the 16% belonged to a high-intent
audience, not the copy. Same facts, different grain, opposite conclusion.

grainpack's traversal drags those sibling records into context *because they
share the asset*, and the answer changes. This repo ships that scenario — and
three more "grain traps" — as executable evals, run in CI:

```bash
npx grainpack eval --strategy graph   # 4/4 pass
npx grainpack eval --strategy flat    # the lexical baseline fails the traps
```

## How it works

`resolve → traverse → score → pack → render`, all deterministic:

1. **Resolve** the question to seed entities by lexical match against your
   schema's labels (IDF-weighted: rare tokens identify things, ubiquitous
   tokens don't). Optional LLM-assisted resolution is on the roadmap.
2. **Traverse** typed relationships outward from the seeds. Hubs are context,
   not corridors (a node with huge fanout is included but not expanded
   through). **Sibling expansion** finds comparables — other records sharing
   a low-fanout neighbor, like the same asset — which is the mechanism that
   catches false attribution.
3. **Score** by seed proximity, lexical overlap, sibling/comparison bonuses,
   and **salience** (numeric outliers within a comparable group; declared
   per-type in your schema, scaled by proximity so a spectacular irrelevant
   outlier can't outrank nearby evidence).
4. **Pack** greedily under a token budget — `broad` / `balanced` /
   `aggressive` — with per-type caps. Every exclusion is recorded with a
   reason.
5. **Render** a deterministic evidence block: records grouped by type, the
   relationship links among them, explicit grain notes, and answering rules
   (cite record ids, separate observation from inference).

The output is a **context package**: selected records each carrying the
traversal path that justified them (`via`), excluded records with reasons,
honest token estimates, and the rendered prompt. Feed it to any LLM — or use
`grainpack ask` to send it to Claude with citations wired up.

## Quick start

```bash
# Interactive demo (bundled dataset, works with no API key)
npx grainpack demo
# With ANTHROPIC_API_KEY set, the demo also generates grounded answers —
# and lets you flip to the flat baseline to watch it walk into the trap.

# Pack a context package
npx grainpack pack --question "What drove the Q3 Onboarding conversion lift?"

# Compare against the no-traversal baseline
npx grainpack pack --question "..." --strategy flat

# Grounded answer in the terminal (needs ANTHROPIC_API_KEY)
npx grainpack ask --question "..." --mode aggressive

# Run the eval traps
npx grainpack eval --strategy graph
npx grainpack eval --strategy flat
npx grainpack eval --strategy graph --judge   # + model-judged answer checks
```

Every command takes `--data <file|dir>` to point at your own dataset; without
it, the bundled synthetic marketing dataset is used.

## Bringing your own data

### 1. The dataset format

A typed property graph in one JSON file (or `schema.json` +
`entities.jsonl` + `edges.jsonl` for larger data):

```jsonc
{
  "formatVersion": 1,
  "name": "my-dataset",
  "schema": {
    "entities": {
      "campaign":  { "label": "name", "aliases": ["initiative"] },
      "execution": { "label": "name", "summary": ["channel", "sentAt"] },
      "metric":    { "label": "name",
                     "salience": { "valueField": "value", "groupBy": "metric" } }
    },
    "relationships": {
      "has_execution": { "from": "campaign",  "to": "execution" },
      "measured_by":   { "from": "execution", "to": "metric" }
    }
  },
  "entities": [
    { "id": "camp_1", "type": "campaign", "fields": { "name": "Q3 Onboarding" } }
  ],
  "edges": [
    { "type": "has_execution", "from": "camp_1", "to": "exec_1" }
  ]
}
```

Schema knobs: `label` (resolution + display field), `aliases` (extra names
for the type), `summary` (fields rendered first), `salience` (opt-in numeric
outlier detection), and per-relationship `expand: "lazy"` (crossed only when
the question mentions the target type). Free text rides along as ordinary
fields and is truncated at packing time, never at ingest. `grainpack
validate` checks the whole thing and reports every problem.

### 2. The mapping layer — from flat exports to the graph

Your data is probably tables. A declarative mapping turns CSV/JSON/JSONL
exports into the dataset format — foreign-key columns become edges:

```jsonc
{
  "formatVersion": 1,
  "schema": { /* as above */ },
  "sources": [
    { "file": "campaigns.csv",  "entity": "campaign",  "id": "campaign_id" },
    { "file": "executions.csv", "entity": "execution", "id": "exec_id",
      "edges": [{ "type": "has_execution", "from": { "column": "campaign_id" } }] }
  ]
}
```

```bash
npx grainpack ingest --map mapping.json --out dataset.json
```

Ingest reports rows read, entities and edges created, and **orphaned
references** — nothing is silently dropped.

**What grainpack deliberately does not do:** extract entities and
relationships from unstructured text. That's a different, much heavier
problem (see Microsoft GraphRAG). grainpack starts where your data already
has a schema — which, for operational business data, it almost always does.

## The eval harness

An eval case pins down a question, the records any correct answer must rest
on, and the seductive wrong conclusion:

```jsonc
{
  "name": "false-attribution-welcome-v2",
  "question": "What content drove the Q3 Onboarding conversion lift…?",
  "mustCite": ["exec_q3_high_intent", "exec_q3_broad", "exec_q2_reactivation", "…"],
  "mustNotConclude": ["Welcome Email v2 is the best-performing creative…"],
  "shouldSurface": "audience selection, not creative, as the likely driver",
  "budgetTokens": 8000
}
```

Two tiers: **deterministic** (always runs, no key): every `mustCite` id is in
the packed selection, within budget. **Judged** (`--judge`, needs a key): the
generated answer is graded against `mustNotConclude` / `shouldSurface` by a
judge model, and reported separately — model-assessed results are never
silently merged with deterministic ones.

The bundled dataset seeds four traps: false attribution, aggregate reversal
(Simpson's paradox), volume mirage, and stale winner. CI runs them on every
push: graph must pass all four; the flat baseline must fail the retrieval
traps. The product claim is a test, not a tagline.

## Using it as a library

```ts
import { loadDataset, packContext, generateAnswer } from 'grainpack';

const { dataset } = await loadDataset('dataset.json');
const pkg = packContext(dataset, 'Why did Q3 outperform Q2?', { mode: 'balanced' });
// pkg.selected — records with provenance; pkg.prompt — the evidence block
const answer = await generateAnswer(pkg); // optional, needs ANTHROPIC_API_KEY
```

Every pipeline stage (`resolveSeeds`, `traverse`, `scoreCandidates`,
`renderPrompt`, …) is exported individually with type declarations.

## Behavior you should know about

- **Deterministic everywhere.** Same dataset + question + options → the same
  package, byte for byte. Stable orderings, no wall clock, seeded example
  generation. This is what makes the evals meaningful.
- **Token counts are estimates** (~4 chars/token), labeled as such.
- **Scale target**: datasets load into memory — thousands to low
  hundreds-of-thousands of records. It is not a database.
- **The `ask`/`--judge` steps** use the Anthropic API (`claude-opus-5` by
  default, `--model` to override) with server-side refusal fallback enabled;
  everything else runs offline.
- Exit codes: `0` ok · `1` fatal · `2` validation errors · `3` eval failures.

## Roadmap

- Optional LLM-assisted seed resolution for oblique questions (schema and
  labels only are sent — never full records).
- Similarity-assist ranking: an optional embeddings hook to *rank* candidates
  the graph produced. Never to replace traversal.
- Time-aware traversal (as-of questions — the stale-winner trap hints at it).
- More example datasets (support tickets, e-commerce) to prove
  domain-agnosticism.

## Development

Node ≥ 20. `npm test` builds and runs the suite, including the grain-trap
evals against the bundled dataset. `npm run generate:example` regenerates the
synthetic dataset deterministically. Design reference in [SPEC.md](SPEC.md).

## License

[MIT](LICENSE)
