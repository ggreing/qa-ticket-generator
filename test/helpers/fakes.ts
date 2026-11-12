/** Shared test fixtures. OWNERSHIP: control session (request additions by message). */
import type { Logger, PullRequestInfo, QaReport } from '../../src/core/contracts';

export function silentLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    debug: (m) => lines.push(`debug: ${m}`),
    info: (m) => lines.push(`info: ${m}`),
    warn: (m) => lines.push(`warn: ${m}`),
    error: (m) => lines.push(`error: ${m}`),
    group: async (name, fn) => {
      lines.push(`group: ${name}`);
      return fn();
    },
  };
}

export function fakePr(overrides: Partial<PullRequestInfo> = {}): PullRequestInfo {
  return {
    owner: 'acme',
    repo: 'shop',
    number: 42,
    title: 'Apply coupon at checkout',
    body: 'Implements PROJ-123.\n\nCloses #7',
    author: 'dev',
    htmlUrl: 'https://github.com/acme/shop/pull/42',
    baseRef: 'main',
    baseSha: 'b'.repeat(40),
    headRef: 'feat/coupon',
    headSha: 'a'.repeat(40),
    headRepoFullName: 'acme/shop',
    isFork: false,
    draft: false,
    labels: ['needs-ai-qa'],
    ...overrides,
  };
}

export function fakeReport(overrides: Partial<QaReport> = {}): QaReport {
  return {
    summary: 'Adds coupon application to checkout.',
    prdAlignment: {
      status: 'partial',
      findings: [
        {
          requirement: 'AC1: a coupon can be applied once',
          source: 'PROJ-123',
          status: 'covered',
          evidence: 'CouponService.apply() checks usage',
          files: ['src/coupon.ts'],
        },
        {
          requirement: 'AC3: expired coupons are rejected',
          source: 'PROJ-123',
          status: 'missing',
          evidence: 'No expiry comparison in coupon.ts',
          files: ['src/coupon.ts'],
        },
      ],
    },
    scenarios: [
      {
        id: 'TC-01',
        title: 'Apply a coupon one second before expiry',
        type: 'edge_case',
        priority: 'P0',
        given: ['a coupon that expires in 1 second'],
        when: ['the user applies it at checkout'],
        then: ['the discount is applied'],
        testData: ['coupon.expiresAt = now + 1s', 'order.subtotal = 30000'],
        relatedRequirements: ['AC3: expired coupons are rejected'],
        relatedFiles: ['src/coupon.ts'],
        rationale: 'Boundary of the expiry rule.',
        confidence: 'high',
      },
    ],
    risks: [
      {
        title: 'Missing expiry check',
        severity: 'high',
        description: 'AC3 not implemented',
        files: ['src/coupon.ts'],
      },
    ],
    assumptions: [],
    ...overrides,
  };
}

/** Input reader backed by a plain object, mirroring @actions/core getInput ('' when unset). */
export function inputs(values: Record<string, string>): (name: string) => string {
  return (name) => values[name] ?? '';
}
