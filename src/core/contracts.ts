/**
 * Shared module contracts for qa-ticket-generator.
 *
 * OWNERSHIP: only the control session edits files under `src/core/`.
 * Work sessions request changes by message; never edit this file on a feature branch.
 * Spec references (e.g. PRE-05) point at docs/SPEC.ko.md.
 */
import type { QaReport } from './schema';

export type { QaReport } from './schema';

// ───────────────────────────── common ─────────────────────────────

export type Language = 'en' | 'ko' | 'ja' | 'zh-CN';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Non-fatal problem surfaced to the user in the report footer / job summary. */
export interface Warning {
  code: WarningCode;
  message: string;
}

export type WarningCode =
  | 'prd_fetch_failed'
  | 'prd_source_unconfigured'
  | 'prd_permission'
  | 'prd_not_linked'
  | 'slack_failed'
  | 'comment_failed'
  | 'state_corrupted'
  | 'files_truncated'
  | 'cost_cap'
  | 'invalid_related_file'
  | 'ast_failed'
  | 'other';

/** Logging abstraction so modules work under both the Action (@actions/core) and the CLI. */
export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** Runs `fn` inside a collapsible log group and returns its result. */
  group<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

// ───────────────────────────── trigger (src/trigger) ─────────────────────────────

/** Normalized GitHub event, built by the input adapter from the webhook payload. */
export interface TriggerEvent {
  /** `github.event_name`, e.g. `pull_request`, `pull_request_target`, `workflow_dispatch`. */
  name: string;
  /** `payload.action`, e.g. `labeled`, `synchronize`. */
  action?: string;
  /** Name of the label that was just added (only for `labeled`). */
  addedLabel?: string;
  pr?: {
    number: number;
    state: 'open' | 'closed';
    labels: string[];
    isFork: boolean;
    draft: boolean;
  };
  /** PR number supplied to `workflow_dispatch` (or the CLI). */
  dispatchPrNumber?: number;
}

export type TriggerSkipReason =
  | 'irrelevant_label'
  | 'label_absent'
  | 'rerun_disabled'
  | 'closed'
  | 'fork_pr'
  | 'unsupported_event'
  | 'no_logic_change';

export interface TriggerDecision {
  run: boolean;
  reason?: TriggerSkipReason;
}

/** TRG-01/02: pure decision function. */
export type DecideTrigger = (
  event: TriggerEvent,
  options: { triggerLabel: string; rerunOnPush: boolean; allowForkPrs: boolean },
) => TriggerDecision;

// ───────────────────────────── context (src/context) ─────────────────────────────

export interface PullRequestInfo {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  author: string;
  htmlUrl: string;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  /** `owner/repo` of the head branch (differs from base for forks). */
  headRepoFullName: string;
  isFork: boolean;
  draft: boolean;
  labels: string[];
}

export type FileStatus = 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed' | 'unchanged';

/** A changed file as returned by the GitHub API (CTX-02/03). JSON-serializable. */
export interface ChangedFile {
  path: string;
  previousPath?: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  /** Unified diff hunks for this file; absent for binary/huge files. */
  patch?: string;
  patchMissing: boolean;
  /** Full file content at head SHA, fetched only for AST-supported languages under 1MB (CTX-03). */
  headContent?: string;
}

/** GitHub read operations used by the pipeline. Implemented in src/context/github.ts. */
export interface GitHubReader {
  getPullRequest(number: number): Promise<PullRequestInfo>;
  /** CTX-02 — paginated, max 3000 files. */
  listChangedFiles(pr: PullRequestInfo): Promise<ChangedFile[]>;
  /** CTX-03 — returns null when missing, binary or larger than `maxBytes`. */
  getFileContent(repoFullName: string, path: string, ref: string, maxBytes?: number): Promise<string | null>;
  /** CTX-04 — reads the repo config file at the BASE sha; null when absent. */
  getRepoConfigText(pr: PullRequestInfo, path: string): Promise<string | null>;
  /** TRG-04 — paths changed between two commits (compare API). */
  listPathsChangedBetween(pr: PullRequestInfo, fromSha: string, toSha: string): Promise<string[]>;
}

// ───────────────────────────── PRD (src/context/prd) ─────────────────────────────

export type PrdSource = 'github' | 'jira' | 'notion';

export interface PrdRef {
  source: PrdSource;
  /** `owner/repo#123`, `PROJ-123`, or the 32-hex Notion page id. */
  id: string;
  url?: string;
  /** The exact text matched in the PR body. */
  raw: string;
}

export interface PrdDocument {
  ref: PrdRef;
  title: string;
  /** Normalized Markdown body (ADF / Notion blocks converted). */
  bodyMarkdown: string;
  /** PRD-07 — extracted acceptance criteria; empty when none found. */
  acceptanceCriteria: string[];
  url: string;
  meta: Record<string, string>;
}

/** PRD-02 — plug-in interface; register implementations in the provider registry. */
export interface PrdProvider {
  readonly source: PrdSource;
  isConfigured(): boolean;
  fetch(ref: PrdRef, signal: AbortSignal): Promise<PrdDocument>;
}

export interface PrdCollection {
  documents: PrdDocument[];
  warnings: Warning[];
}

/** PRD-01 — pure: PR body → refs (dedupe, order of appearance, max N). */
export type ExtractPrdRefs = (
  body: string,
  options: { defaultOwner: string; defaultRepo: string; jiraProjectKeys: string[]; maxDocuments: number },
) => PrdRef[];

// ───────────────────────────── preprocess (src/preprocess) — ★ Rust boundary ─────────────────────────────
// Everything in this section MUST stay JSON-serializable (no functions, Dates, Maps, class instances).

export interface ScoringWeights {
  prdKeyword: number;
  changeSize: number;
  domainPath: number;
  testOrConfigPenalty: number;
  boostPaths: string[];
  penalizePaths: string[];
}

export interface PreprocessOptions {
  /** Per-LLM-call input token budget (`token-budget`). */
  tokenBudget: number;
  /** Extra exclude globs from the repo config (added to the built-in noise list). */
  exclude: string[];
  /** Globs rescued from the built-in noise list. */
  include: string[];
  scoring: ScoringWeights;
  /** Subset of ['typescript','tsx','javascript','python','java','go']. */
  astLanguages: string[];
  /** Fixed prompt overhead reserved inside the budget (system prompt + instructions). */
  reservedTokens: number;
}

export interface PreprocessInput {
  files: ChangedFile[];
  prdDocuments: PrdDocument[];
  options: PreprocessOptions;
}

export interface Hunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Hunk body with +/-/space prefixes, already redacted. */
  text: string;
}

export interface CodeContext {
  kind: 'symbol' | 'lines';
  /** Symbol name for `symbol` contexts (function/method/class). */
  name?: string;
  startLine: number;
  endLine: number;
  /** Redacted source text. */
  text: string;
}

export interface PackedFile {
  path: string;
  previousPath?: string;
  status: FileStatus;
  score: number;
  hunks: Hunk[];
  contexts: CodeContext[];
  /** PRE-03 — human summary for dependency/config files instead of raw diff (e.g. "added stripe@15"). */
  summary?: string;
  estimatedTokens: number;
}

export interface CodeChunk {
  id: string;
  files: PackedFile[];
  estimatedTokens: number;
}

export type FileSkipReason = 'noise' | 'binary' | 'too_large' | 'patch_missing' | 'budget' | 'cost_cap';

export interface SkippedFile {
  path: string;
  reason: FileSkipReason;
}

export interface RedactionCount {
  type: string;
  count: number;
}

export interface PreprocessOutput {
  mode: 'single' | 'map_reduce';
  /** Ordered by priority: chunk[0] holds the highest-scored files. */
  chunks: CodeChunk[];
  /** Redacted (PRE-05) and truncated (≤20K tokens each) PRD documents. */
  prdDocuments: PrdDocument[];
  skipped: SkippedFile[];
  redactions: RedactionCount[];
  estimatedTokens: number;
  /** User-visible, content-free problems (e.g. `ast_failed`: grammar load or parse failures, counts only). */
  warnings?: Warning[];
}

/** PRE-05 applied to free text outside PreprocessInput (PR title/body). Pure. */
export type RedactText = (text: string) => { text: string; redactions: RedactionCount[] };

/**
 * PRE-01 — the preprocessing engine. `run` is synchronous, deterministic and I/O-free.
 * Async work (loading tree-sitter WASM grammars) happens once in the factory, so a future
 * Rust/WASM implementation can expose the exact same shape.
 */
export interface PreprocessEngine {
  run(input: PreprocessInput): PreprocessOutput;
}

export type CreatePreprocessEngine = (options: { astLanguages: string[] }) => Promise<PreprocessEngine>;

/** TRG-04 helper — pure: true when the path would be dropped by the noise filter. */
export type IsNoisePath = (path: string, options: Pick<PreprocessOptions, 'include' | 'exclude'>) => boolean;

// ───────────────────────────── LLM (src/llm) ─────────────────────────────

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface PromptContext {
  pr: Pick<PullRequestInfo, 'number' | 'title' | 'body' | 'htmlUrl' | 'author' | 'baseRef' | 'headRef'>;
  prdDocuments: PrdDocument[];
  language: Language;
  maxScenarios: number;
  repoInstructions?: { extraInstructions?: string; glossary?: { term: string; meaning: string }[] };
}

export interface GenerateRequest {
  context: PromptContext;
  chunk: CodeChunk;
  /** Files not shown to the model, listed so it can mention coverage gaps. */
  skipped: SkippedFile[];
  /** `single` = whole PR in one call, `map` = one chunk of a map-reduce run. */
  phase: 'single' | 'map';
}

export interface MergeRequest {
  context: PromptContext;
  partials: QaReport[];
}

export interface LlmResult<T> {
  value: T;
  usage: LlmUsage;
  model: string;
  stopReason: string;
}

export interface LlmProvider {
  readonly id: string;
  generateReport(req: GenerateRequest, signal: AbortSignal): Promise<LlmResult<QaReport>>;
  mergeReports(req: MergeRequest, signal: AbortSignal): Promise<LlmResult<QaReport>>;
  /** LLM-08/10 — USD estimate for a call with the given token counts. */
  estimateCostUsd(usage: LlmUsage): number;
}

export interface OrchestrateOptions {
  maxCostUsd: number;
  /** LLM-07 — max concurrent map calls. */
  concurrency: number;
  /** Expected output tokens per call, used for the pre-call cost estimate (LLM-10). */
  expectedOutputTokens: number;
}

export interface OrchestrateResult {
  report: QaReport;
  usage: LlmUsage;
  costUsd: number;
  calls: number;
  /** Chunks dropped by the cost guard, reported as `cost_cap`. */
  skipped: SkippedFile[];
  warnings: Warning[];
}

// ───────────────────────────── delivery (src/delivery) ─────────────────────────────

export type AlignmentStatus = QaReport['prdAlignment']['status'];

export interface RunMeta {
  model: string;
  effort: Effort;
  mode: PreprocessOutput['mode'] | 'none';
  sha: string;
  usage: LlmUsage;
  costUsd: number;
  durationMs: number;
  calls: number;
  skipped: SkippedFile[];
  redactions: RedactionCount[];
  prdSources: PrdRef[];
  warnings: Warning[];
  dryRun: boolean;
}

export type RunStatus = 'ok' | 'skipped' | 'error';

export interface FinalReport {
  status: RunStatus;
  pr: PullRequestInfo;
  /** null when skipped/error. */
  report: QaReport | null;
  meta: RunMeta;
  skipReason?: TriggerSkipReason | 'no_files';
  error?: { code: string; message: string };
  language: Language;
}

/** DLV-02 — persisted inside the PR comment as `<!-- qtg-state:{json} -->`. */
export interface DeliveryState {
  v: 1;
  /** Last analyzed head SHA (TRG-04). */
  sha?: string;
  slack?: { channel: string; ts: string; replies: string[] };
}

export interface DeliveryResult {
  channel: 'pr_comment' | 'slack' | 'summary';
  ok: boolean;
  /** Partial state to merge into DeliveryState (e.g. new Slack ts). */
  statePatch?: Partial<DeliveryState>;
  url?: string;
  warning?: Warning;
}

export interface Deliverer {
  readonly channel: DeliveryResult['channel'];
  deliver(final: FinalReport, state: DeliveryState): Promise<DeliveryResult>;
}

/** DLV-01/02 — marker comment storage on the PR. */
export interface PrCommentStore {
  /** Finds the marker comment and parses its state (corrupted state → `{ v: 1 }` + warning). */
  load(pr: PullRequestInfo): Promise<{ commentId: number | null; state: DeliveryState; warnings: Warning[] }>;
  /** Creates or updates the marker comment with the rendered body and state. */
  save(
    pr: PullRequestInfo,
    commentId: number | null,
    body: string,
    state: DeliveryState,
  ): Promise<{ commentId: number; url: string }>;
}
