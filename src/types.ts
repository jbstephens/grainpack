// ---------------------------------------------------------------------------
// Dataset format (input contract) — see SPEC.md §4.1
// ---------------------------------------------------------------------------

export interface SalienceDef {
  /** Numeric field whose outliers within a group deserve attention. */
  valueField: string;
  /** Field whose value groups comparable records (e.g. metric kind). */
  groupBy?: string;
}

export interface EntityTypeDef {
  /** Field used for resolution and display. Falls back to the id. */
  label?: string;
  /** Extra names for the type, matched against question tokens. */
  aliases?: string[];
  /** Fields to render first in compact record views. */
  summary?: string[];
  /** Opt-in outlier detection for this type's numeric values. */
  salience?: SalienceDef;
}

export type ExpandMode = 'always' | 'default' | 'lazy';

export interface RelationshipDef {
  from: string;
  to: string;
  /** Traversal eagerness. "lazy" edges are crossed only when the question mentions the target type. */
  expand?: ExpandMode;
}

export interface DatasetSchema {
  entities: Record<string, EntityTypeDef>;
  relationships: Record<string, RelationshipDef>;
}

export interface Entity {
  id: string;
  type: string;
  fields: Record<string, unknown>;
}

export interface Edge {
  type: string;
  from: string;
  to: string;
}

export interface DatasetFile {
  formatVersion: 1;
  name?: string;
  schema: DatasetSchema;
  entities: Entity[];
  edges: Edge[];
}

/** Indexed, queryable dataset built by loadDataset()/indexDataset(). */
export interface Dataset {
  name: string;
  schema: DatasetSchema;
  entities: Map<string, Entity>;
  byType: Map<string, Entity[]>;
  /** Outgoing edges by source id. */
  out: Map<string, Array<{ edge: string; to: string }>>;
  /** Incoming edges by target id. */
  in: Map<string, Array<{ edge: string; from: string }>>;
  /** Token -> entity ids containing it (labels + string fields). */
  tokenIndex: Map<string, Set<string>>;
  /** Per-entity token set, for lexical scoring. */
  entityTokens: Map<string, Set<string>>;
  edgeCount: number;
  tokensEstimate: number;
}

export interface ValidationProblem {
  level: 'error' | 'warning';
  message: string;
}

// ---------------------------------------------------------------------------
// Mapping config (ingest contract) — see SPEC.md §4.2
// ---------------------------------------------------------------------------

export interface MappingEdgeDef {
  type: string;
  /** Edge source comes from this column; the current row is the target. */
  from?: { column: string };
  /** Edge target comes from this column; the current row is the source. */
  to?: { column: string };
}

export interface MappingSourceDef {
  file: string;
  entity: string;
  id: string;
  /** Optional rename/select: outputField -> sourceColumn. Omit to take all columns. */
  fields?: Record<string, string>;
  edges?: MappingEdgeDef[];
}

export interface MappingConfig {
  formatVersion: 1;
  name?: string;
  schema: DatasetSchema;
  sources: MappingSourceDef[];
}

export interface IngestReport {
  sources: Array<{
    file: string;
    entity: string;
    rowsRead: number;
    entitiesCreated: number;
    edgesCreated: number;
    orphanedReferences: number;
  }>;
  problems: ValidationProblem[];
}

// ---------------------------------------------------------------------------
// Context package (output contract) — see SPEC.md §4.3
// ---------------------------------------------------------------------------

export type Mode = 'broad' | 'balanced' | 'aggressive';
export type Strategy = 'graph' | 'flat';
export type SelectReason = 'seed' | 'traversal' | 'sibling' | 'comparison' | 'lexical';
export type ExcludeReason = 'low-score' | 'budget' | 'redundant' | 'lazy-edge';

export interface Via {
  edge: string;
  from?: string;
  sharedNeighbor?: string;
}

export interface Seed {
  id: string;
  matchedOn: string;
  score: number;
}

export interface SelectedRecord {
  id: string;
  type: string;
  score: number;
  via: Via[];
  reason: SelectReason;
  tokensEstimate: number;
}

export interface ExcludedRecord {
  id: string;
  reason: ExcludeReason;
  score: number;
}

export interface ContextPackage {
  formatVersion: 1;
  tool: 'grainpack';
  toolVersion: string;
  question: string;
  dataset: { name: string; records: number; tokensEstimate: number };
  mode: Mode;
  strategy: Strategy;
  budgetTokens: number;
  seeds: Seed[];
  selected: SelectedRecord[];
  excluded: ExcludedRecord[];
  stats: {
    considered: number;
    selected: number;
    excluded: number;
    tokensBefore: number;
    tokensAfter: number;
    reductionPct: number;
  };
  prompt: string;
}

export interface PackOptions {
  mode?: Mode;
  budgetTokens?: number;
  strategy?: Strategy;
  maxSeeds?: number;
  depth?: number;
}

// ---------------------------------------------------------------------------
// Eval case format — see SPEC.md §4.4
// ---------------------------------------------------------------------------

export interface EvalCase {
  formatVersion?: 1;
  name: string;
  question: string;
  mustCite: string[];
  mustNotConclude?: string[];
  shouldSurface?: string;
  budgetTokens?: number;
  mode?: Mode;
}

export interface JudgedResult {
  passed: boolean;
  violations: string[];
  surfaced: boolean | null;
  notes: string;
}

export interface EvalResult {
  name: string;
  strategy: Strategy;
  passedCitations: boolean;
  missingCitations: string[];
  withinBudget: boolean;
  tokensAfter: number;
  /** Present only when an answer was generated and judged (API key available). */
  judged?: JudgedResult | null;
}
