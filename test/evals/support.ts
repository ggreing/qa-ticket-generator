/** Helpers for eval tests: an oracle report, a null report and a stand-in preprocess engine. */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { RubricClientLike } from '../../evals/rubric';
import { type EvalCase, type GradedCase, loadCases } from '../../evals/schema';
import type { CreatePreprocessEngine, QaReport } from '../../src/core/contracts';

export const CASES_ROOT = resolve('evals/cases');
export const EVALS_ROOT = resolve('evals');

/** The synthetic cases, all of which carry ground truth. */
export function gradedCases(ids?: string[]): GradedCase[] {
  return loadCases(CASES_ROOT, ids).map((c) => {
    if (c.expected === null) throw new Error(`${c.id} has no expected.json`);
    return { ...c, expected: c.expected };
  });
}

/** A copy of a case with its ground truth removed, like a real-PR snapshot. */
export const withoutGroundTruth = (c: EvalCase, id = `real-${c.id}`): EvalCase => ({
  ...c,
  id,
  expected: null,
  origin: 'real',
});

/**
 * The report a perfect reviewer would write for a case, built from its `expected.json`.
 * Running it through the grader checks the grader's wiring (it must pass everything).
 */
export function oracleReport(evalCase: GradedCase): QaReport {
  const { expected } = evalCase;
  const file = evalCase.files.find((f) => !f.patchMissing)?.path ?? '';
  return {
    summary: 'Oracle summary.',
    prdAlignment: {
      status: expected.expectedAlignment,
      findings: expected.mustFindings.map((m) => ({
        requirement: `${m.labels[0]}: ${m.requirement}`,
        source: evalCase.prdDocuments[0]?.ref.id ?? '',
        status: m.accept[0] ?? 'covered',
        evidence: 'see code',
        files: [file],
      })),
    },
    scenarios: expected.mustScenarios.map((m, i) => ({
      id: `TC-${String(i + 1).padStart(2, '0')}`,
      title: m.risk,
      type: 'edge_case' as const,
      priority: 'P1' as const,
      given: [m.keywords.map((group) => group[0]).join(' ')],
      when: ['the tester performs the step'],
      then: ['the expected result is observed'],
      testData: [],
      relatedRequirements: [],
      relatedFiles: [file],
      rationale: 'Planted risk.',
      confidence: 'high' as const,
    })),
    risks: expected.injection
      ? [
          {
            title: 'Prompt injection attempt',
            severity: 'high' as const,
            description: `The PRD tries to ${expected.injection.riskKeywords.map((g) => g[0]).join(' ')} the review.`,
            files: [],
          },
        ]
      : [],
    assumptions: [],
  };
}

/** What a reviewer that did nothing would return: no findings, no scenarios. */
export function nullReport(status: QaReport['prdAlignment']['status']): QaReport {
  return { summary: '', prdAlignment: { status, findings: [] }, scenarios: [], risks: [], assumptions: [] };
}

/**
 * Minimal preprocess engine for tests: one chunk holding every file's patch as a single hunk.
 * It does no filtering, redaction or AST work, so it must never be used for a real eval run.
 */
export const fakeEngine: CreatePreprocessEngine = async () => ({
  run: (input) => {
    const files = input.files
      .filter((f) => f.patch)
      .map((f) => ({
        path: f.path,
        status: f.status,
        score: 1,
        hunks: [{ header: '@@', oldStart: 1, oldLines: 0, newStart: 1, newLines: 0, text: f.patch ?? '' }],
        contexts: [],
        estimatedTokens: Math.ceil((f.patch ?? '').length / 3.2),
      }));
    const estimatedTokens = files.reduce((n, f) => n + f.estimatedTokens, 0);
    return {
      mode: 'single',
      chunks: files.length > 0 ? [{ id: 'c1', files, estimatedTokens }] : [],
      prdDocuments: input.prdDocuments,
      skipped: input.files
        .filter((f) => !f.patch)
        .map((f) => ({ path: f.path, reason: 'patch_missing' as const })),
      redactions: [],
      estimatedTokens,
    };
  },
});

/** Real-PR stand-ins used by the tests: id → the synthetic case its snapshot is copied from. */
export const REAL_DEMO = {
  'real-demo-1': { source: 'coupon-expiry-missing', split: 'dev', number: 9001 },
  'real-demo-2': { source: 'report-timezone', split: 'test', number: 9002 },
} as const;
/** Listed in real-sources.json but not on disk, like a snapshot nobody has fetched yet. */
export const REAL_ABSENT = 'real-absent-3';

/**
 * A throwaway `evals/` directory: the committed synthetic cases and splits, plus two real-PR
 * snapshots (no expected.json; the first one with options.json) and one listed-but-absent one.
 */
export function makeEvalsRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'qtg-evals-'));
  cpSync(CASES_ROOT, join(root, 'cases'), { recursive: true });
  cpSync(join(EVALS_ROOT, 'splits.json'), join(root, 'splits.json'));
  for (const [id, { source, number }] of Object.entries(REAL_DEMO)) {
    const dir = join(root, 'real', id);
    cpSync(join(CASES_ROOT, source), dir, { recursive: true });
    rmSync(join(dir, 'expected.json'));
    const pr = JSON.parse(readFileSync(join(dir, 'pr.json'), 'utf8')) as { number: number };
    writeFileSync(join(dir, 'pr.json'), JSON.stringify({ ...pr, number }));
  }
  writeFileSync(join(root, 'real', 'real-demo-1', 'options.json'), JSON.stringify({ tokenBudget: 12_000 }));
  mkdirSync(join(root, 'rounds'), { recursive: true });
  writeFileSync(
    join(root, 'real-sources.json'),
    JSON.stringify([
      ...Object.entries(REAL_DEMO).map(([id, { split }]) => ({ id, split, repo: 'acme/demo' })),
      { id: REAL_ABSENT, split: 'dev', repo: 'acme/demo' },
    ]),
  );
  return root;
}

export type RubricBody = Parameters<RubricClientLike['messages']['parse']>[0];

/** The scenario ids in a rubric judge request, read back from its `<report_data>` block. */
export function scenarioIdsIn(body: RubricBody): string[] {
  const text = String(body.messages[0]?.content);
  const json = text.slice(text.indexOf('<report_data>\n') + 14, text.lastIndexOf('\n</report_data>'));
  return (JSON.parse(json) as { scenarios: { id: string }[] }).scenarios.map((s) => s.id);
}

/** Usage the rubric judge double reports for every call. */
export const RUBRIC_USAGE = { input_tokens: 9_000, output_tokens: 2_000 };

/**
 * Rubric judge double: scores every scenario 1/2/1/2 (scenario score 1.5) and the report
 * `alignment`/1/2. With ground truth the grade replaces `alignment`.
 */
export function fakeRubricClient(alignment = 0, seen: RubricBody[] = []): RubricClientLike {
  return {
    messages: {
      parse: async (body) => {
        seen.push(body);
        return {
          parsed_output: {
            scenarios: scenarioIdsIn(body).map((id) => ({
              id,
              actionability: 1,
              actionabilityWhy: 'no test data',
              traceability: 2,
              traceabilityWhy: 'cites the AC and the file',
              riskRelevance: 1,
              riskRelevanceWhy: 'plausible',
              priority: 2,
              priorityWhy: 'matches impact',
            })),
            report: {
              alignmentCorrectness: alignment,
              alignmentCorrectnessWhy: 'one status looks wrong',
              concision: 1,
              concisionWhy: 'some repetition',
              honesty: 2,
              honestyWhy: 'assumptions are labelled',
            },
          },
          stop_reason: 'end_turn',
          model: body.model,
          usage: RUBRIC_USAGE,
        };
      },
    },
  };
}
