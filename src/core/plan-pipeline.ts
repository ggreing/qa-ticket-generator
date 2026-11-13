/**
 * Plan phase (SPEC v3 §2.1, §4, §5): spec -> QA cases -> tickets in every configured sink.
 * Pure wiring over injected modules. OWNERSHIP: control session only.
 */

import { createHash } from 'node:crypto';
import type {
  CaseSetSummary,
  CaseSink,
  ExistingCaseTicket,
  LintCaseStyle,
  PlanRequest,
  PlanResult,
  PlanSync,
  Priority,
  QaCase,
  ReconcileCases,
  RenderedCase,
  SinkKind,
  SyncOp,
} from './cases';
import type { QtgConfig } from './config';
import type {
  Language,
  LlmProvider,
  Logger,
  PrdCollection,
  PrdDocument,
  PrdProvider,
  PrdRef,
  RedactText,
  Warning,
} from './contracts';
import { QtgError, toQtgError } from './errors';
import { PLAN_EXPECTED_OUTPUT_TOKENS, PRD_TIMEOUT_MS } from './limits';

export interface PlanDeps {
  logger: Logger;
  prdProviders: PrdProvider[];
  collectPrdDocuments: (
    refs: PrdRef[],
    providers: PrdProvider[],
    options: { timeoutMs: number; signal: AbortSignal },
  ) => Promise<PrdCollection>;
  redactText: RedactText;
  llm: LlmProvider;
  generatePlan: (
    req: PlanRequest,
    provider: LlmProvider,
    options: { maxCostUsd: number; expectedOutputTokens: number },
    signal: AbortSignal,
  ) => Promise<PlanResult>;
  reconcileCases: ReconcileCases;
  planSync: PlanSync;
  renderCase: (c: QaCase, language: Language) => RenderedCase;
  lintCaseStyle: LintCaseStyle;
  sinks: CaseSink[];
}

export interface SinkOutcome {
  kind: SinkKind;
  ok: boolean;
  created: number;
  updated: number;
  suggested: number;
  obsoleted: number;
  unchanged: number;
  summaryUrl?: string;
  error?: string;
}

export interface PlanOutcome {
  status: 'ok' | 'error';
  spec: PrdRef;
  cases: QaCase[];
  sinks: SinkOutcome[];
  costUsd: number;
  styleViolations: number;
  warnings: Warning[];
  error?: { code: string; message: string };
  /** Set when generation was skipped: the spec text is the same as at the last plan. */
  skipped?: 'spec_unchanged';
}

/**
 * §5 — sinks that can hold cases for this spec. Jira cases are sub-tasks of the spec story, so
 * the Jira sink only applies to Jira specs; for other specs it is skipped with a warning.
 */
export function usableSinks(sinks: CaseSink[], spec: PrdRef, warnings: Warning[]): CaseSink[] {
  return sinks.filter((s) => {
    if (!s.isConfigured()) return false;
    if (s.kind === 'jira' && spec.source !== 'jira') {
      warnings.push({
        code: 'other',
        message: `The jira sink was skipped: ${spec.raw} is not a Jira issue, and case sub-tasks need a Jira story.`,
      });
      return false;
    }
    return true;
  });
}

/** §5 — the sink whose tickets are the source of existing cases: jira > notion > github-issue > file. */
export function primarySink(sinks: CaseSink[]): CaseSink | null {
  const order: SinkKind[] = ['jira', 'notion', 'github-issue', 'file'];
  for (const kind of order) {
    const s = sinks.find((x) => x.kind === kind && x.isConfigured());
    if (s) return s;
  }
  return null;
}

/** §4 — digest of the (redacted) spec text the model sees. */
export function specDigestOf(
  doc: Pick<PrdDocument, 'title' | 'bodyMarkdown' | 'acceptanceCriteria'>,
): string {
  const text = [doc.title, doc.bodyMarkdown, ...doc.acceptanceCriteria]
    .join('\n')
    .replace(/\r\n?/g, '\n')
    .trim();
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/**
 * True when every active spec-origin case was planned from this exact spec text. Tickets a person
 * edited are left out: the tool never rewrites them, so their payload keeps an older digest.
 */
export function specUnchanged(existing: ExistingCaseTicket[], digest: string): boolean {
  const planned = existing
    .filter((t) => t.writtenHash !== null && t.currentHash === t.writtenHash)
    .map((t) => t.lastWritten)
    .filter((c): c is QaCase => c !== null && c.lifecycle === 'active' && c.origin === 'spec');
  return planned.length > 0 && planned.every((c) => c.specDigest === digest);
}

function redactDoc(doc: PrdDocument, redact: RedactText): PrdDocument {
  return {
    ...doc,
    title: redact(doc.title).text,
    bodyMarkdown: redact(doc.bodyMarkdown).text,
    acceptanceCriteria: doc.acceptanceCriteria.map((a) => redact(a).text),
  };
}

export async function runPlan(
  deps: PlanDeps,
  cfg: QtgConfig,
  specRef: PrdRef,
  signal: AbortSignal,
): Promise<PlanOutcome> {
  const { logger } = deps;
  const warnings: Warning[] = [];
  const outcome: PlanOutcome = {
    status: 'ok',
    spec: specRef,
    cases: [],
    sinks: [],
    costUsd: 0,
    styleViolations: 0,
    warnings,
  };

  try {
    const sinks = usableSinks(deps.sinks, specRef, warnings);
    if (sinks.length === 0)
      throw new QtgError('config_invalid', 'No configured sink. Check the "sinks" input.');

    const prd = await logger.group('Fetch spec', () =>
      deps.collectPrdDocuments([specRef], deps.prdProviders, { timeoutMs: PRD_TIMEOUT_MS, signal }),
    );
    warnings.push(...prd.warnings);
    const raw = prd.documents[0];
    if (!raw) throw new QtgError('prd_required', `The spec ${specRef.raw} could not be read.`);
    const spec = redactDoc(raw, deps.redactText);

    const primary = primarySink(sinks);
    const existing: ExistingCaseTicket[] = primary
      ? await logger.group(`Read existing cases (${primary.kind})`, () => primary.list(specRef, signal))
      : [];

    const digest = specDigestOf(spec);
    if (!cfg.forcePlan && specUnchanged(existing, digest)) {
      logger.info(
        'The spec has not changed since the last plan; no new cases were generated. Set force-plan to plan again.',
      );
      outcome.skipped = 'spec_unchanged';
      outcome.cases = existing.map((t) => t.lastWritten).filter((c): c is QaCase => c !== null);
      // The file sink starts empty on every Action run: write the unchanged cases again so the
      // artifact (and the next run's previous-cases) still exists.
      // The file sink only writes what it was told this run, so feed it the cases first.
      for (const sink of sinks.filter((s) => s.kind === 'file')) {
        const urls = new Map<string, string>();
        for (const t of existing) if (t.url) urls.set(t.caseId, t.url);
        try {
          await syncSink(
            sink,
            sink === primary ? existing : null,
            outcome.cases,
            (c) => deps.renderCase(c, cfg.language),
            specRef,
            urls,
            deps,
            signal,
          );
          await sink.publishSummary(
            specRef,
            buildSummary(specRef, spec.title, cfg.language, outcome.cases, urls, deps.llm, 0),
            signal,
          );
        } catch (err) {
          logger.warn(`file: could not write the unchanged cases: ${(err as Error).message}`);
        }
      }
      return outcome;
    }

    const plan = await logger.group('Generate QA cases', () =>
      deps.generatePlan(
        {
          spec,
          related: prd.documents.slice(1).map((d) => redactDoc(d, deps.redactText)),
          existing: existing.map((t) => ({
            caseId: t.caseId,
            title: t.lastWritten?.title ?? '',
            acLabels: t.lastWritten?.acLabels ?? [],
            technique: t.lastWritten?.technique ?? 'happy_path',
            lifecycle: t.lastWritten?.lifecycle ?? 'active',
          })),
          language: cfg.language,
          maxCases: cfg.maxCases,
          repoInstructions: cfg.repoInstructions,
        },
        deps.llm,
        { maxCostUsd: cfg.maxCostUsd, expectedOutputTokens: PLAN_EXPECTED_OUTPUT_TOKENS },
        signal,
      ),
    );
    outcome.costUsd = plan.costUsd;
    warnings.push(...plan.warnings);

    const reconciled = deps.reconcileCases(specRef.id, existing, plan.cases);
    warnings.push(...reconciled.warnings);
    outcome.cases = reconciled.cases.map((c) =>
      c.lifecycle === 'active' && c.origin === 'spec' ? { ...c, specDigest: digest } : c,
    );

    // §3.1 — count style violations; they are reported, not blocking.
    for (const c of outcome.cases) {
      if (c.lifecycle === 'active') outcome.styleViolations += deps.lintCaseStyle(c, cfg.language).length;
    }

    const render = (c: QaCase) => deps.renderCase(c, cfg.language);
    const urls = new Map<string, string>();
    for (const sink of sinks) {
      outcome.sinks.push(
        await syncSink(
          sink,
          sink === primary ? existing : null,
          outcome.cases,
          render,
          specRef,
          urls,
          deps,
          signal,
        ),
      );
    }

    const summary = buildSummary(
      specRef,
      spec.title,
      cfg.language,
      outcome.cases,
      urls,
      deps.llm,
      outcome.costUsd,
    );
    for (const sink of sinks) {
      const result = outcome.sinks.find((s) => s.kind === sink.kind);
      try {
        const res = await sink.publishSummary(specRef, summary, signal);
        if (result && res.url) result.summaryUrl = res.url;
      } catch (err) {
        logger.warn(`${sink.kind}: summary failed: ${(err as Error).message}`);
        warnings.push({ code: 'other', message: `${sink.kind}: could not publish the case summary.` });
      }
    }
    if (outcome.sinks.every((s) => !s.ok)) {
      throw new QtgError('internal', 'No sink accepted the QA cases. See the warnings for each sink.');
    }
  } catch (err) {
    const e = toQtgError(err);
    logger.error(`${e.code}: ${e.message}`);
    outcome.status = 'error';
    outcome.error = { code: e.code, message: e.userMessage };
    if (e.usage) outcome.costUsd = deps.llm.estimateCostUsd(e.usage);
  }
  return outcome;
}

export async function syncSink(
  sink: CaseSink,
  known: ExistingCaseTicket[] | null,
  cases: QaCase[],
  render: (c: QaCase) => RenderedCase,
  spec: PrdRef,
  urls: Map<string, string>,
  deps: Pick<PlanDeps, 'logger' | 'planSync'>,
  signal: AbortSignal,
): Promise<SinkOutcome> {
  const out: SinkOutcome = {
    kind: sink.kind,
    ok: true,
    created: 0,
    updated: 0,
    suggested: 0,
    obsoleted: 0,
    unchanged: 0,
  };
  try {
    const existing = known ?? (await sink.list(spec, signal));
    for (const t of existing) if (t.url && !urls.get(t.caseId)) urls.set(t.caseId, t.url);
    const ops: SyncOp[] = deps.planSync(existing, cases, render);
    // DLV-08 spirit: one failing op is a warning, the rest still run.
    for (const op of ops) {
      try {
        await applyOp(sink, spec, op, render, urls, out, signal);
      } catch (err) {
        if ((err as Error).name === 'AbortError') throw err;
        deps.logger.warn(`${sink.kind}: ${op.op} failed: ${(err as Error).message}`);
        out.ok = false;
        out.error = `${op.op} failed for at least one case`;
      }
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    deps.logger.warn(`${sink.kind}: sync failed: ${(err as Error).message}`);
    out.ok = false;
    out.error = 'sync failed';
  }
  return out;
}

async function applyOp(
  sink: CaseSink,
  spec: PrdRef,
  op: SyncOp,
  render: (c: QaCase) => RenderedCase,
  urls: Map<string, string>,
  out: SinkOutcome,
  signal: AbortSignal,
): Promise<void> {
  switch (op.op) {
    case 'create': {
      const res = await sink.create(spec, op.case, render(op.case), signal);
      if (res.url) urls.set(op.case.caseId, res.url); // the file sink returns no url: never let it blank a ticket link
      out.created++;
      return;
    }
    case 'update':
      await sink.update(op.ticket, op.case, render(op.case), signal);
      out.updated++;
      return;
    case 'suggest':
      await sink.suggest(op.ticket, op.case, render(op.case), signal);
      out.suggested++;
      return;
    case 'obsolete':
      await sink.markObsolete(op.ticket, signal);
      out.obsoleted++;
      return;
    case 'unchanged':
      out.unchanged++;
      return;
  }
}

export function buildSummary(
  spec: PrdRef,
  title: string,
  language: Language,
  cases: QaCase[],
  urls: Map<string, string>,
  llm: LlmProvider,
  costUsd: number,
  opts: { mode?: 'plan' | 'verify'; sha?: string } = {},
): CaseSetSummary {
  const byPriority: Record<Priority, number> = { P0: 0, P1: 0, P2: 0 };
  let obsolete = 0;
  for (const c of cases) {
    if (c.lifecycle === 'obsolete') obsolete++;
    else byPriority[c.priority]++;
  }
  return {
    specRef: spec,
    specTitle: title,
    language,
    cases: cases.map((c) => ({
      caseId: c.caseId,
      title: c.title,
      priority: c.priority,
      lifecycle: c.lifecycle,
      ...(c.codeStatus ? { codeStatus: c.codeStatus.status } : {}),
      url: urls.get(c.caseId),
    })),
    counts: {
      total: cases.length - obsolete,
      byPriority,
      obsolete,
      ...(opts.mode === 'verify' ? { byCodeStatus: countCodeStatus(cases) } : {}),
    },
    meta: { model: llm.id, costUsd, mode: opts.mode ?? 'plan', ...(opts.sha ? { sha: opts.sha } : {}) },
  };
}

function countCodeStatus(
  cases: QaCase[],
): Record<'implemented' | 'missing' | 'contradicts' | 'unknown', number> {
  const out = { implemented: 0, missing: 0, contradicts: 0, unknown: 0 };
  for (const c of cases) if (c.lifecycle === 'active' && c.codeStatus) out[c.codeStatus.status]++;
  return out;
}
