# grainpack — Design Spec

Relationship-aware context packing for structured data. Given a typed entity
graph and a natural-language question, grainpack resolves the question to seed
entities, traverses the graph's explicit relationships, and packs a small,
provenance-rich **context package** for an LLM — so the model reasons over the
right evidence at the right grain instead of a pile of semantically-similar
records.

**Status:** implemented (v0.1.0) — design reference; see README.md for usage.
Implementation deltas from this spec: seed resolution gained IDF weighting, a
distinctive-token requirement, and a relative quality gate; traversal gained
hub gating (high-fanout nodes are included but not expanded through) and a
"salient leaves always ride along" pass; salience bonuses are scaled by
proximity. Each was forced by the trap evals during tuning.
**Proposed stack:** TypeScript, Node ≥ 20, zero runtime dependencies in the
core (the optional answer layer uses `@anthropic-ai/sdk`), published to npm,
runnable via `npx grainpack`.

---

## 1. Problem

Retrieval for LLM apps defaults to semantic similarity: embed everything,
retrieve what sounds related, hope the model sorts it out. For data that is
*already structured* — campaigns and their executions, tickets and their
customers, orders and their line items — this throws away the most valuable
signal the data has: its relationships and its **grain**.

The failure mode isn't missing information; it's *misread* information. A
record that looks like a winner at one grain ("this email hit 16% conversion")
is an artifact of context at another ("…in the one execution that targeted a
high-intent audience; the same email did 2–4% everywhere else"). Flat
retrieval hands the model the 16% record and gets back a confident,
well-written, wrong answer.

Existing graph-RAG projects (e.g. Microsoft GraphRAG) attack a different
problem: LLM-extracting knowledge graphs from *unstructured text* — heavy,
expensive, non-deterministic. Nothing small and deterministic serves the far
more common case: **your data already has a schema; use it.**

## 2. Goals / Non-goals

**Goals**

- A dataset format any structured domain can be expressed in: typed entities,
  typed relationships, declared in a schema. Nothing domain-specific in core.
- Deterministic retrieval: entity resolution → typed traversal → sibling/
  comparison expansion → scoring → budget-constrained packing. No vector DB,
  no embeddings, no API key required for the core pipeline.
- A documented **context package** output contract with full provenance:
  every selected record carries the traversal path that justified it; every
  exclusion carries a reason; token estimates before/after.
- A declarative **mapping/ingest layer**: tables (CSV/JSON/JSONL) + a mapping
  config → dataset format. The on-ramp for real data.
- An **eval harness** for grain traps: labeled test cases (question +
  must-cite records + must-not-conclude claims) that measure whether a
  retrieval strategy avoids confident-but-unsupported conclusions.
- An optional **answer layer** (Claude API) and a self-contained **demo**
  showing the full flow on a synthetic marketing dataset seeded with traps.
- Usable as a typed library and as a CLI, like any good small tool.

**Non-goals**

- Extracting entities/relationships from unstructured text (LLM graph
  construction). Different problem, different weight class. Documented as
  out of scope; the mapping layer is the supported on-ramp.
- Embedding/vector infrastructure. A similarity-assist hook may come later
  (roadmap); it will never be required.
- Being a database. Datasets load fully into memory; the target is thousands
  to low hundreds-of-thousands of records, not billions.
- Authentication, multi-user anything, production analytics.

## 3. Concepts

- **Entity** — a typed record: `{ id, type, fields }`.
- **Edge** — a typed, directed relationship instance: `{ type, from, to }`.
- **Schema** — declares entity types (with a `label` field for resolution and
  display) and relationship types (with endpoints and traversal defaults).
- **Grain** — the level of aggregation at which a fact is true. Grainpack's
  core claim: facts must travel with their grain (a metric belongs to an
  execution, not to the asset the execution used).
- **Sibling expansion** — for a selected entity, find *comparable* entities:
  other nodes reachable through a shared neighbor via the same edge type
  (e.g. other executions using the same asset; other campaigns in the same
  quarter). This is the generic mechanism behind catching false attribution.
- **Grain trap** — a dataset pattern where flat retrieval produces a
  plausible wrong conclusion (aggregate-vs-segment reversal, reused asset
  across audiences, survivor bias). The eval harness tests against these.
- **Context package** — the output: selected evidence + provenance + a
  rendered prompt block.

## 4. Contracts

Four documented formats. These are the product; the code is an implementation.

### 4.1 Dataset format (input)

Single file (`dataset.json`) or split (`schema.json` + `entities.jsonl` +
`edges.jsonl`) for larger data.

```jsonc
{
  "formatVersion": 1,
  "name": "acme-marketing",
  "schema": {
    "entities": {
      "campaign":  { "label": "name", "aliases": ["campaigns", "initiative"] },
      "asset":     { "label": "name", "aliases": ["creative", "email", "content"] },
      "execution": { "label": "name", "aliases": ["send", "run"] },
      "metric":    { "label": "name", "summary": ["value", "unit"] }
    },
    "relationships": {
      "has_execution": { "from": "campaign",  "to": "execution" },
      "uses_asset":    { "from": "execution", "to": "asset" },
      "measured_by":   { "from": "execution", "to": "metric" },
      "targets":       { "from": "execution", "to": "audience", "expand": "always" }
    }
  },
  "entities": [
    { "id": "camp_q3_onboarding", "type": "campaign",
      "fields": { "name": "Q3 Onboarding", "quarter": "Q3", "objective": "activation" } },
    { "id": "exec_q3_high_intent", "type": "execution",
      "fields": { "name": "Q3 High-Intent Send", "channel": "email", "sentAt": "2026-08-02" } }
  ],
  "edges": [
    { "type": "has_execution", "from": "camp_q3_onboarding", "to": "exec_q3_high_intent" },
    { "type": "uses_asset",    "from": "exec_q3_high_intent", "to": "asset_welcome_v2" }
  ]
}
```

Schema semantics:

- `label`: the field used for lexical resolution and display.
- `aliases`: extra names for the *type* (so "which emails…" resolves to
  `asset` records where relevant).
- `summary`: fields to prioritize when rendering a compact record view.
- Relationship `expand`: `"always" | "default" | "lazy"` — traversal
  eagerness (lazy edges are crossed only when the target type matches the
  question). Default: `"default"`.
- Free-text content (email HTML, ad copy) rides along as ordinary fields;
  large fields are truncated intelligently at packing time, never at ingest.
- Validation: every edge's endpoints must exist and match the declared
  types; ids unique; unknown schema keys tolerated (additive versioning,
  same rule as marketo-email-export's manifest).

### 4.2 Mapping config (ingest)

`grainpack ingest --map mapping.json --out dataset.json` turns flat exports
into the dataset format. Deliberately declarative — no code.

```jsonc
{
  "formatVersion": 1,
  "schema": { /* same schema block as the dataset format */ },
  "sources": [
    { "file": "campaigns.csv", "entity": "campaign", "id": "campaign_id" },
    { "file": "executions.csv", "entity": "execution", "id": "exec_id",
      "fields": { "name": "exec_name", "channel": "channel" },   // rename/select; omit = take all columns
      "edges": [
        { "type": "has_execution", "from": { "column": "campaign_id" }, "direction": "in" },
        { "type": "uses_asset",    "to":   { "column": "asset_id" } }
      ] },
    { "file": "metrics.jsonl", "entity": "metric", "id": "metric_id",
      "edges": [ { "type": "measured_by", "from": { "column": "exec_id" }, "direction": "in" } ] }
  ]
}
```

- Sources: CSV (RFC-4180, built-in parser), JSON array, JSONL.
- Foreign-key columns become edges; `direction: "in"` means the current row
  is the edge's target. Composite/missing keys are reported, not silently
  dropped: ingest emits a report (rows read, entities created, edges
  created, orphaned references) — the "no silent truncation" rule.

### 4.3 Context package (output)

The manifest.json of this project. Everything downstream consumes this.

```jsonc
{
  "formatVersion": 1,
  "tool": "grainpack",
  "toolVersion": "0.1.0",
  "question": "What content drove the Q3 conversion lift, and what should we reuse?",
  "dataset": { "name": "acme-marketing", "records": 4850, "tokensEstimate": 620000 },
  "mode": "balanced",
  "budgetTokens": 8000,
  "seeds": [
    { "id": "camp_q3_onboarding", "matchedOn": "label ~ 'Q3'", "score": 0.92 }
  ],
  "selected": [
    { "id": "exec_q3_high_intent", "type": "execution", "score": 0.81,
      "via": [ { "edge": "has_execution", "from": "camp_q3_onboarding" } ],
      "reason": "traversal", "tokensEstimate": 310 },
    { "id": "exec_q2_reactivation", "type": "execution", "score": 0.64,
      "via": [ { "edge": "uses_asset", "sharedNeighbor": "asset_welcome_v2" } ],
      "reason": "sibling", "tokensEstimate": 290 }
  ],
  "excluded": [
    { "id": "asset_banner_03", "reason": "low-score", "score": 0.11 },
    { "id": "exec_q1_promo",  "reason": "budget",     "score": 0.41 }
  ],
  "stats": {
    "considered": 214, "selected": 27, "excluded": 187,
    "tokensBefore": 61200, "tokensAfter": 8400, "reductionPct": 86
  },
  "prompt": "…rendered evidence block…"
}
```

- `reason` for selection: `seed | traversal | sibling | comparison`.
- `reason` for exclusion: `low-score | budget | redundant | lazy-edge`.
- `via` is the provenance chain — the UI's "why is this here" and the
  auditability story.
- The rendered `prompt` block groups evidence by entity type, includes each
  record's id (so answers can cite), states the grain explicitly ("metrics
  below are per-execution"), and instructs the model to distinguish evidence
  from inference and cite record ids.
- Token counts are estimates (chars/4), labeled as such.

### 4.4 Eval case format

```jsonc
{
  "formatVersion": 1,
  "name": "false-attribution-welcome-v2",
  "question": "What content drove the Q3 conversion lift, and what should we reuse?",
  "mustCite": ["exec_q3_high_intent", "exec_q3_broad", "exec_q2_reactivation",
               "metric_conv_q3_hi", "metric_conv_q3_broad"],
  "mustNotConclude": [
    "Welcome Email v2 is the best-performing creative and should be reused"
  ],
  "shouldSurface": "audience selection, not creative, as the likely driver",
  "budgetTokens": 8000
}
```

Two check tiers:

1. **Deterministic (always runs):** every `mustCite` id present in the
   context package's `selected` set, within budget. This validates retrieval
   without any LLM.
2. **Judged (runs when an API key is present):** generate the answer, then a
   judge call evaluates `mustNotConclude` / `shouldSurface` against it.
   Judged results are labeled as model-assessed, never silently merged with
   deterministic results.

`grainpack eval` runs a directory of cases and prints a pass/fail table. The
flagship readout: the same cases run with `--strategy flat` (lexical top-k
over all records, no traversal — the honest baseline) vs `--strategy graph`,
showing the baseline failing `mustCite` and, when judged, walking into the
trap.

## 5. Engine design

Pipeline: **resolve → traverse → score → pack → render**. Every stage pure
and independently testable; every stage's output inspectable in the package.

1. **Resolve.** Tokenize the question; match against entity labels, field
   values, and type aliases (normalized, stemmed-lite: lowercase, plural
   folding). Score matches by specificity (full-label match > token overlap).
   Optional `--resolve llm` sends *only the schema and entity labels* (never
   full records) to a model to pick seeds — useful for oblique questions;
   off by default.
2. **Traverse.** BFS from seeds along typed edges, depth default 3,
   respecting `expand` semantics. Then **sibling expansion**: for each
   traversed node, find co-neighbors through shared nodes (other executions
   of the same asset; capped per node, default 5, ranked by recency/metric
   salience). Then **comparison expansion**: when the question implies
   comparison ("why did X outperform Y", "compare", "vs"), resolve both
   sides and traverse both; when only one side is explicit, siblings of the
   seed at the same entity type serve as the comparison set.
3. **Score.** Deterministic weighted sum: seed proximity (hop count), edge
   eagerness, lexical overlap between record fields and question, sibling/
   comparison bonus, and a metric-salience bonus for records whose numeric
   fields are outliers within their sibling set (that's what surfaces the
   16%-vs-4% spread). Weights fixed per mode; documented.
4. **Pack.** Greedy by score under the token budget. Modes set budget and
   thresholds: **broad** (recall-leaning, larger budget share to context
   records), **balanced** (default), **aggressive** (evidence-only,
   strongest records, hard trim of long text fields). Redundancy pruning:
   near-duplicate records (same type, same neighbors, overlapping fields)
   beyond N are dropped as `redundant`. Every drop is recorded.
5. **Render.** Deterministic prompt block (§4.3). Same package in, same
   prompt out — snapshot-testable.

## 6. CLI surface

```
npx grainpack <command> [options]

Commands:
  ingest     Map CSV/JSON/JSONL sources into a dataset (§4.2)
  validate   Check a dataset against its schema; print stats
  inspect    Show an entity and its neighborhood (--id, --depth)
  pack       Question → context package JSON (the core command)
  ask        pack + send to Claude, print grounded answer  [needs API key]
  eval       Run eval cases; compare --strategy graph|flat
  demo       Serve the interactive demo locally (§8)

pack options:
  --data <file>            dataset.json (or schema+jsonl dir)
  --question "<q>"         the question
  --mode broad|balanced|aggressive     (default balanced)
  --budget <tokens>        override the mode's default budget
  --strategy graph|flat    flat = lexical top-k baseline, for comparison
  --resolve lexical|llm    seed resolution (default lexical)
  --out <file>             write package (default stdout)
```

Exit codes: 0 ok · 1 fatal · 2 validation errors · 3 eval failures.
Stdout carries data (packages, tables); progress goes to stderr — same
discipline as marketo-email-export.

## 7. Answer layer (optional)

- `@anthropic-ai/sdk`, the only dependency, and only loaded by `ask`/`eval`
  judged tier/demo answer step. Core never touches it.
- `ANTHROPIC_API_KEY` from env. Default model `claude-opus-5` (override
  `--model`); adaptive thinking left at API defaults; streaming output.
- The system prompt enforces the contract: answer only from the evidence
  block, cite record ids for every claim, separate "observed" from
  "inferred", and say so when evidence is insufficient.
- The answer step records which record ids were cited, feeding the eval's
  deterministic citation check on answers as well as packages.

## 8. Demo

`grainpack demo` serves a single-file, no-build vanilla JS page (same
zero-dependency ethos) against a local API wrapping the library. Flow mirrors
the POC spec this project distills:

1. **The universe** — dataset stats (records, est. tokens), entity-type
   counts, a simple relationship diagram.
2. **The question** — three suggested questions + freeform. The flagship is
   the false-attribution trap question.
3. **Resolution & traversal made visible** — seeds, then the expanding
   neighborhood with `via` chains shown.
4. **Packing** — mode toggle (broad/balanced/aggressive) live-updates the
   selected/excluded lists and the before/after token comparison.
5. **The answer** — when a key is present, the grounded answer with
   clickable citations that open the underlying record; keyless mode stops
   at the package and shows the rendered prompt instead.
6. **The kicker** — a "flat retrieval" toggle that re-runs the same question
   with `--strategy flat` and shows the answer the trap was built to catch.
   Same facts, different grain, different answer. That's the demo moment.

## 9. Example dataset: `examples/marketing/`

Synthetic, generated by a seeded script (`examples/marketing/generate.ts`,
deterministic — no `Math.random()` without a seed). Target: ~4–6k records
across campaign / asset / execution / metric / audience, sized so full-dump
is obviously silly (~500k+ est. tokens) and reduction is believable, not
cartoonish.

Seeded grain traps (each with a matching eval case in `examples/marketing/evals/`):

1. **False attribution** — "Welcome Email v2": 16% conversion in one
   high-intent execution, 2–4% elsewhere; "Welcome Email v1" quietly
   consistent at 5–6%. (The flagship.)
2. **Aggregate reversal** — a landing page weak on average but the best
   performer for one audience segment (Simpson's paradox).
3. **Volume mirage** — a campaign with the most total conversions but
   below-median conversion *rate*; the question asks what's "working".
4. **Stale winner** — an asset whose strong metrics all predate a pricing
   change; recency matters.

## 10. Internal design

- **Modules:** `dataset` (parse/validate/index: adjacency maps by edge type),
  `ingest` (mapping executor + CSV/JSONL readers), `resolve`, `traverse`,
  `score`, `pack`, `render`, `flat` (baseline strategy), `evalrunner`,
  `answer` (SDK wrapper), `cli`, `demo-server` (node:http, serves static page
  + JSON endpoints). Library barrel `index.ts` exports the pipeline stages
  individually and a one-call `packContext(dataset, question, opts)`.
- **Indexes built at load:** entity-by-id, entities-by-type, out/in adjacency
  per edge type, inverted token index over labels + string fields (powers
  resolution and the flat baseline without embeddings).
- **Determinism everywhere:** stable sort orders, seeded generation, no
  wall-clock in scoring. Same inputs → byte-identical package (modulo
  `exportedAt`-style timestamps, kept out of the package body for this
  reason).
- **Tests:** node:test; golden-file tests for packages over a small fixture
  graph; trap tests asserting the flat baseline *fails* `mustCite` where the
  graph strategy passes (the repo's own eval, run in CI); CSV parser edge
  cases; determinism test (two runs, deep-equal).
- **Packaging:** mirror marketo-email-export — `prepare` build, tests gate
  publish, CI Node 20/22, MIT, declaration files, npx-runnable.

## 11. Roadmap (documented, not built)

- Similarity-assist ranking: optional embeddings hook to *rank* candidates
  the graph produced (never to replace traversal).
- LLM entity/relationship extraction from unstructured text — out of scope
  by design; revisit only as a separate ingest plugin.
- Streaming datasets / on-disk indexes for very large graphs.
- Time-aware traversal (as-of queries) — the stale-winner trap hints at it.
- Additional example datasets (support tickets, e-commerce) to prove
  domain-agnosticism.

## 12. Open questions (decide at build time)

1. npm name `grainpack` (checked available 2026-09-11; claim early).
2. Demo diagram: hand-rolled SVG vs. text layout — no dependencies allowed.
3. Whether `ask` should also emit the package alongside the answer by
   default (leaning yes: provenance should never be more than one flag away).
