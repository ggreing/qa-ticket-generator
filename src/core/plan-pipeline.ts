/**
 * Plan phase (SPEC v3 §2.1, §4, §5): spec -> QA cases -> tickets in every configured sink.
 * Pure wiring over injected modules. OWNERSHIP: control session only.
 */
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
import { EXPECTED_OUTPUT_TOKENS, PRD_TIMEOUT_MS } from './limits';

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
        { maxCostUsd: cfg.maxCostUsd, expectedOutputTokens: EXPECTED_OUTPUT_TOKENS },
        signal,
      ),
    );
    outcome.costUsd = plan.costUsd;
    warnings.push(...plan.warnings);

    const reconciled = deps.reconcileCases(specRef.id, existing, plan.cases);
    warnings.push(...reconciled.warnings);
    outcome.cases = reconciled.cases;

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
    for (const t of existing) urls.set(t.caseId, urls.get(t.caseId) ?? t.url);
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
      urls.set(op.case.caseId, res.url);
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

function buildSummary(
  spec: PrdRef,
  title: string,
  language: Language,
  cases: QaCase[],
  urls: Map<string, string>,
  llm: LlmProvider,
  costUsd: number,
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
      url: urls.get(c.caseId),
    })),
    counts: { total: cases.length - obsolete, byPriority, obsolete },
    meta: { model: llm.id, costUsd, mode: 'plan' },
  };
}
