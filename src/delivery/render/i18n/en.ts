import type { Strings } from './types';

export const en: Strings = {
  title: 'AI QA Scenarios',
  alignment: 'PRD alignment',
  alignmentStatus: { aligned: 'Aligned', partial: 'Partial', misaligned: 'Misaligned', no_prd: 'No PRD' },
  noPrd: 'No linked PRD — scenarios are inferred from code only (low confidence)',
  linked: 'Linked',
  sections: {
    alignment: 'PRD Alignment',
    scenarios: 'Scenarios',
    risks: 'Risks',
    assumptions: 'Assumptions',
    notes: 'Notes',
    skippedFiles: 'Skipped files',
    redactions: 'Redacted secrets',
  },
  table: { requirement: 'Requirement', status: 'Status', evidence: 'Evidence' },
  requirementStatus: {
    covered: 'covered',
    missing: 'missing',
    contradicts: 'contradicts',
    unclear: 'unclear',
  },
  scenarioType: { happy_path: 'Happy', edge_case: 'Edge', negative: 'Negative', regression: 'Regression' },
  level: { high: 'high', medium: 'medium', low: 'low' },
  related: 'Related',
  why: 'Why',
  confidence: 'Confidence',
  omittedScenarios: (n) =>
    `${n} lower-priority scenario(s) were left out to fit GitHub's comment size limit. The full report is in the workflow's Job Summary and in report.json.`,
  omittedFindings: (n) =>
    `${n} requirement row(s) were left out to fit GitHub's comment size limit. The full report is in the workflow's Job Summary and in report.json.`,
  truncated:
    "This comment was cut to fit GitHub's size limit. The full report is in the workflow's Job Summary and in report.json.",
  runFailed: 'Run failed',
  errorCode: 'Error code',
  noFiles:
    'No logic changes to analyze — every changed file was filtered out (lock files, generated code, binaries and similar).',
  skipped: 'Analysis was skipped',
  dryRun: 'dry run',
  footer: {
    tokens: (i, o) => `in ${i} / out ${o} tokens`,
    cache: (r, w) => `cache read ${r}, write ${w}`,
    calls: (n) => `${n} LLM call(s)`,
    filesSkipped: (n) => `${n} file(s) skipped`,
    redactions: (n) => `${n} secret(s) redacted`,
  },
  skipReason: {
    noise: 'noise',
    binary: 'binary',
    too_large: 'too large',
    patch_missing: 'no diff available',
    budget: 'token budget',
    cost_cap: 'cost cap',
  },
  slack: {
    openPr: 'Open PR',
    viewReport: 'View full report',
    scenarios: 'Scenarios',
    topRisks: 'Top risks',
    findings: 'Requirements needing attention',
    detailsInThread: 'Scenario details are in the thread.',
  },
};
