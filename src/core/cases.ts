/**
 * v3 contracts: spec-driven QA cases, their sync to ticket systems, and the two phases
 * (plan from the spec, verify against a PR). SPEC.v3.ko.md §2–§7.
 * OWNERSHIP: control session only. Request changes by message.
 */
import type { Language, LlmUsage, Logger, PrdDocument, PrdRef, Warning } from './contracts';

export type Mode = 'plan' | 'verify';

/** §3 — test technique labels (also the risk checklist the model walks per AC). */
export const TECHNIQUES = [
  'happy_path',
  'boundary',
  'equivalence',
  'invalid_input',
  'state_transition',
  'permission',
  'concurrency',
  'failure',
  'idempotency',
  'compatibility',
  'locale_time',
  'data_integrity',
] as const;
export type Technique = (typeof TECHNIQUES)[number];

export type Priority = 'P0' | 'P1' | 'P2';
export type CodeStatus = 'implemented' | 'missing' | 'contradicts' | 'unknown';
export type Lifecycle = 'active' | 'obsolete';

/** Case content as the model writes it (no ids, no lifecycle, no code status). */
export interface CaseDraft {
  title: string;
  acLabels: string[];
  technique: Technique;
  priority: Priority;
  preconditions: string[];
  testData: string[];
  steps: string[];
  /** First line is the pass/fail observation. */
  expected: string[];
  /** One factual sentence: what the spec leaves out that makes this easy to miss. */
  whyEasyToMiss: string;
  origin: 'spec' | 'code';
}

/** §3 — a case owned by the tool. Human-owned fields live only in the ticket system. */
export interface QaCase extends CaseDraft {
  /** Stable id, e.g. `PROJ-123-C07`. Assigned by the sync engine, never by the model. */
  caseId: string;
  /** PrdRef.id of the spec the case belongs to. */
  specRef: string;
  lifecycle: Lifecycle;
  /**
   * Digest of the spec text this case was planned from (tool-owned). A plan run whose spec digest
   * matches every active spec case skips generation, so an unchanged spec never churns tickets.
   */
  specDigest?: string;
  codeStatus?: {
    status: CodeStatus;
    /** One factual sentence naming file and function. */
    evidence: string;
    files: string[];
    sha: string;
  };
}

/** Fields people own in the ticket system; read for context, never written by the tool (§3, §4.2). */
export interface HumanFields {
  execStatus?: string;
  assignee?: string;
}

/** A case ticket that already exists in a sink. */
export interface ExistingCaseTicket {
  caseId: string;
  /** Sink-specific handle: Jira key, issue number, Notion page id, CSV row key. */
  ticketRef: string;
  url: string;
  /** The case as the tool last wrote it (from the hidden payload), or null if unreadable. */
  lastWritten: QaCase | null;
  /** Hash of the tool-owned text the tool last wrote (§4.5), or null if missing. */
  writtenHash: string | null;
  /** Hash of the tool-owned text as it is now; differs from writtenHash when a person edited it. */
  currentHash: string;
  human: HumanFields;
}

/** Text of one case rendered for a sink (labels in the output language). */
export interface RenderedCase {
  /** `[P0][경계값] 만료 1초 지난 쿠폰 적용 시 거부` style. */
  title: string;
  /** Markdown body (GitHub / file); sinks convert when they need another format. */
  markdown: string;
  /** Plain field map for structured sinks (Notion properties, CSV columns). */
  fields: Record<string, string>;
  /** Hash of the tool-owned text, stored hidden in the ticket (§4.5). */
  hash: string;
}

export type SinkKind = 'jira' | 'github-issue' | 'notion' | 'file';

/** §5 — one ticket system. Implementations never touch HumanFields. */
export interface CaseSink {
  readonly kind: SinkKind;
  isConfigured(): boolean;
  /** Every case ticket of this spec, active and obsolete. */
  list(spec: PrdRef, signal: AbortSignal): Promise<ExistingCaseTicket[]>;
  create(
    spec: PrdRef,
    c: QaCase,
    r: RenderedCase,
    signal: AbortSignal,
  ): Promise<{ ticketRef: string; url: string }>;
  /** Rewrite tool-owned fields only. */
  update(t: ExistingCaseTicket, c: QaCase, r: RenderedCase, signal: AbortSignal): Promise<void>;
  /** §4.5 — a person edited the body: leave it and post the proposed change as a comment. */
  suggest(t: ExistingCaseTicket, c: QaCase, r: RenderedCase, signal: AbortSignal): Promise<void>;
  /** §4.4 — mark (never close or delete) a case the spec no longer produces. */
  markObsolete(t: ExistingCaseTicket, signal: AbortSignal): Promise<void>;
  /** Spec-side overview (issue/story comment, file index). Updated in place. */
  publishSummary(spec: PrdRef, summary: CaseSetSummary, signal: AbortSignal): Promise<{ url?: string }>;
}

export interface CaseSetSummary {
  specRef: PrdRef;
  specTitle: string;
  language: Language;
  cases: {
    caseId: string;
    title: string;
    priority: Priority;
    lifecycle: Lifecycle;
    codeStatus?: CodeStatus;
    url?: string;
  }[];
  counts: {
    total: number;
    byPriority: Record<Priority, number>;
    obsolete: number;
    byCodeStatus?: Record<CodeStatus, number>;
  };
  meta: { model: string; costUsd: number; mode: Mode; sha?: string };
}

/** §4 — sync plan computed by the pure engine; applied per sink. */
export type SyncOp =
  | { op: 'create'; case: QaCase }
  | { op: 'update'; ticket: ExistingCaseTicket; case: QaCase }
  | { op: 'suggest'; ticket: ExistingCaseTicket; case: QaCase }
  | { op: 'obsolete'; ticket: ExistingCaseTicket }
  | { op: 'unchanged'; ticket: ExistingCaseTicket; case: QaCase };

// ───────────────────────────── LLM side (src/llm) ─────────────────────────────

/** A case the model wrote, possibly claiming an existing id (§4.1). */
export interface PlannedCase extends CaseDraft {
  /** The existing caseId this case continues, or null for a new case. Validated by the sync engine. */
  reuseCaseId: string | null;
}

export interface PlanRequest {
  spec: PrdDocument;
  /** Linked documents the spec points to (context only). */
  related: PrdDocument[];
  /** Existing cases (active and obsolete) so the model can reuse ids. */
  existing: Pick<QaCase, 'caseId' | 'title' | 'acLabels' | 'technique' | 'lifecycle'>[];
  language: Language;
  maxCases: number;
  repoInstructions?: {
    extraInstructions?: string;
    glossary?: { term: string; meaning: string }[];
    styleExamples?: string[];
  };
}

export interface PlanResult {
  cases: PlannedCase[];
  usage: LlmUsage;
  costUsd: number;
  calls: number;
  warnings: Warning[];
  /** P2 cases dropped by max-cases or the cost cap, counted for the summary (§6). */
  dropped: number;
}

export interface VerifyRequest {
  spec: PrdDocument;
  cases: QaCase[];
  /** Preprocessed code chunks (v2 PreprocessOutput) and PR context. */
  pre: import('./contracts').PreprocessOutput;
  pr: import('./contracts').PromptContext['pr'];
  sha: string;
  language: Language;
  maxNewCases: number;
  /**
   * §2.2 — where new code-derived cases may come from. `null`: the first check of this PR (or a
   * manual run), the whole PR. Otherwise only risks introduced by these hunks, which are the
   * changes since the last checked commit; an empty list means no new cases at all.
   */
  newCaseScope?: { sinceSha: string; changes: { path: string; patch: string }[] } | null;
}

export interface VerifyResult {
  statuses: { caseId: string; status: CodeStatus; evidence: string; files: string[] }[];
  /** Code-derived cases (origin 'code'), not yet given ids. */
  newCases: CaseDraft[];
  /** v2 requirement alignment for the PR summary. */
  alignment: import('./schema').QaReport['prdAlignment'];
  usage: LlmUsage;
  costUsd: number;
  calls: number;
  warnings: Warning[];
}

// ───────────────────────────── module function shapes ─────────────────────────────

/** src/cases — §4.1: validate reused ids, assign new ids (`<specKey>-C<nn>`), mark obsolete. Pure. */
export type ReconcileCases = (
  specRef: string,
  existing: ExistingCaseTicket[],
  planned: PlannedCase[],
) => { cases: QaCase[]; warnings: Warning[] };

/** src/cases — §4.2–§4.5: compute ops for one sink. Pure. */
export type PlanSync = (
  existing: ExistingCaseTicket[],
  next: QaCase[],
  render: (c: QaCase) => RenderedCase,
) => SyncOp[];

/** src/cases — §3.1: deterministic AI-style lint. Returns violations per case. Pure. */
export type LintCaseStyle = (c: CaseDraft, language: Language) => { rule: string; text: string }[];

export interface SinkContext {
  logger: Logger;
  language: Language;
}

/** src/cases — §2.2: merge verify statuses and code-derived cases into the case set. Pure. */
export type ApplyVerify = (
  cases: QaCase[],
  result: Pick<VerifyResult, 'statuses' | 'newCases'>,
  sha: string,
  specRef: string,
) => { cases: QaCase[]; warnings: Warning[] };
