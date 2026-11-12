import type { Strings } from './types';

export const en: Strings = {
  title: 'AI QA',
  alignmentStatus: {
    aligned: 'Aligned',
    partial: 'Partially aligned',
    misaligned: 'Misaligned',
    no_prd: 'No PRD',
  },
  noPrd: 'No linked PRD — scenarios are inferred from code only (low confidence)',
  linked: 'Linked',
  actionNeeded: (n) => `Action needed (${n})`,
  allCovered: (n) => `All ${n} requirement(s) are covered`,
  needsCheck: (n) => `Needs a check (${n})`,
  p0Checklist: (n) => `P0 checklist (${n})`,
  noP0: 'No P0 scenarios',
  more: (n) => `and ${n} more`,
  card: {
    given: 'Preconditions',
    data: 'Data',
    steps: 'Steps',
    expected: 'Expected',
    related: 'Related',
    why: 'Why',
  },
  confidence: 'Confidence',
  level: { high: 'high', medium: 'medium', low: 'low' },
  otherTickets: (n) => `P1 · P2 tickets (${n})`,
  requirementDetails: (n) => `Verdict per requirement (${n})`,
  sections: {
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
  omittedTickets: (n) =>
    `${n} lower-priority ticket(s) were left out to fit GitHub's comment size limit. The full report is in the workflow's Job Summary and in report.json.`,
  omittedFindings: (n) =>
    `${n} requirement row(s) were left out to fit GitHub's comment size limit. The full report is in the workflow's Job Summary and in report.json.`,
  truncated:
    "This comment was cut to fit GitHub's size limit. The full report is in the workflow's Job Summary and in report.json.",
  runFailed: 'Run failed',
  errorCode: 'Error code',
  errorHint: {
    cost_cap:
      'The estimated cost is above the `max-cost-usd` limit, so no analysis was run. Raise `max-cost-usd` in the workflow, or lower `token-budget` to analyze the change in smaller parts.',
  },
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
    tickets: 'Tickets',
    detailsInThread: 'Ticket details are in the thread.',
  },
};
