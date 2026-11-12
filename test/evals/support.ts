/** Helpers for eval tests: an oracle report, a null report and a stand-in preprocess engine. */
import { resolve } from 'node:path';
import type { EvalCase } from '../../evals/schema';
import type { CreatePreprocessEngine, QaReport } from '../../src/core/contracts';

export const CASES_ROOT = resolve('evals/cases');

/**
 * The report a perfect reviewer would write for a case, built from its `expected.json`.
 * Running it through the grader checks the grader's wiring (it must pass everything).
 */
export function oracleReport(evalCase: EvalCase): QaReport {
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
      id: `S-${String(i + 1).padStart(2, '0')}`,
      title: m.risk,
      type: 'edge_case' as const,
      priority: 'P1' as const,
      given: [m.keywords.map((group) => group[0]).join(' ')],
      when: ['the tester performs the step'],
      then: ['the expected result is observed'],
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
