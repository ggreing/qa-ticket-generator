/** Builders for delivery tests. */
import type { FinalReport, QaReport, RunMeta } from '../../src/core/contracts';
import { fakePr, fakeReport } from '../helpers/fakes';

export function runMeta(overrides: Partial<RunMeta> = {}): RunMeta {
  return {
    model: 'claude-opus-5-5',
    effort: 'high',
    mode: 'single',
    sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    usage: { inputTokens: 31_200, outputTokens: 5_800, cacheReadTokens: 0, cacheWriteTokens: 0 },
    costUsd: 0.24,
    durationMs: 74_000,
    calls: 1,
    skipped: [
      { path: 'package-lock.json', reason: 'noise' },
      { path: 'yarn.lock', reason: 'noise' },
      { path: 'assets/logo.png', reason: 'binary' },
    ],
    redactions: [{ type: 'aws_access_key', count: 2 }],
    prdSources: [
      { source: 'jira', id: 'PROJ-123', raw: 'PROJ-123', url: 'https://acme.atlassian.net/browse/PROJ-123' },
      { source: 'github', id: 'acme/shop#45', raw: '#45', url: 'https://github.com/acme/shop/issues/45' },
    ],
    warnings: [],
    dryRun: false,
    ...overrides,
  };
}

export function finalReport(overrides: Partial<FinalReport> = {}, meta: Partial<RunMeta> = {}): FinalReport {
  return {
    status: 'ok',
    pr: fakePr(),
    report: richReport(),
    meta: runMeta(meta),
    language: 'en',
    ...overrides,
  };
}

/** A report that exercises every section: mixed finding statuses, three priorities, risks, assumptions. */
export function richReport(overrides: Partial<QaReport> = {}): QaReport {
  const base = fakeReport();
  const first = base.scenarios[0] as QaReport['scenarios'][number];
  return {
    ...base,
    scenarios: [
      first,
      {
        ...first,
        id: 'S-02',
        title: 'Apply the same coupon twice in parallel',
        type: 'negative',
        priority: 'P1',
        given: ['a coupon that was never used', 'two checkout tabs for the same cart'],
        when: ['both tabs apply the coupon at the same moment'],
        then: ['exactly one request succeeds', 'the other one gets a `COUPON_ALREADY_USED` error'],
        relatedRequirements: ['AC1: a coupon can be applied once'],
        confidence: 'medium',
      },
      {
        ...first,
        id: 'S-03',
        title: 'Checkout without a coupon still works',
        type: 'regression',
        priority: 'P2',
        given: ['a cart without a coupon'],
        when: ['the user pays'],
        then: ['the total is unchanged'],
        relatedRequirements: [],
        relatedFiles: [],
        rationale: '',
        confidence: 'low',
      },
    ],
    risks: [
      { title: 'No audit log', severity: 'low', description: 'Coupon use is not logged.', files: [] },
      ...base.risks,
    ],
    assumptions: ['Coupon codes are case-insensitive.'],
    ...overrides,
  };
}
