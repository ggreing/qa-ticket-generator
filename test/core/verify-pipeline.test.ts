import { describe, expect, it, vi } from 'vitest';
import { applyVerify, planSync, renderCase } from '../../src/cases';
import type { CaseSink, ExistingCaseTicket, QaCase, RenderedCase, VerifyResult } from '../../src/core/cases';
import { parseRepoConfig, type QtgConfig, resolveConfig } from '../../src/core/config';
import type { PrdRef, PullRequestInfo } from '../../src/core/contracts';
import type { PlanOutcome } from '../../src/core/plan-pipeline';
import { runVerify, type VerifyDeps } from '../../src/core/verify-pipeline';
import { inputs, silentLogger } from '../helpers/fakes';

const signal = new AbortController().signal;
const specRef: PrdRef = { source: 'github', id: 'acme/shop#12', raw: '#12' };

const pr: PullRequestInfo = {
  owner: 'acme',
  repo: 'shop',
  number: 3,
  title: 'Coupon expiry',
  body: 'Implements #12',
  author: 'dev',
  htmlUrl: 'https://github.com/acme/shop/pull/3',
  baseRef: 'main',
  baseSha: 'b'.repeat(40),
  headRef: 'feat',
  headSha: 'a'.repeat(40),
} as PullRequestInfo;

const baseCase = (n: number, over: Partial<QaCase> = {}): QaCase => ({
  caseId: `shop-12-C0${n}`,
  specRef: specRef.id,
  lifecycle: 'active',
  title: `케이스 ${n}`,
  acLabels: ['AC1'],
  technique: 'boundary',
  priority: 'P0',
  preconditions: ['회원 로그인'],
  testData: ['쿠폰 = EXP1'],
  steps: ['결제 화면 진입'],
  expected: ['적용 거부'],
  whyEasyToMiss: '만료 시각 포함 여부 정의 없음',
  origin: 'spec',
  ...over,
});

/** A stateful in-memory sink that stores what the tool wrote (like the file sink). */
function memorySink(
  initial: QaCase[] = [],
): CaseSink & { store: Map<string, { c: QaCase; r: RenderedCase }> } {
  const store = new Map<string, { c: QaCase; r: RenderedCase }>();
  for (const c of initial) store.set(c.caseId, { c, r: renderCase(c, 'ko') });
  const ticket = (id: string): ExistingCaseTicket => {
    const e = store.get(id) as { c: QaCase; r: RenderedCase };
    return {
      caseId: id,
      ticketRef: id,
      url: `https://t/${id}`,
      lastWritten: e.c,
      writtenHash: e.r.hash,
      currentHash: e.r.hash,
      human: {},
    };
  };
  return {
    kind: 'github-issue',
    store,
    isConfigured: () => true,
    list: async () => [...store.keys()].map(ticket),
    create: async (_s, c, r) => {
      store.set(c.caseId, { c, r });
      return { ticketRef: c.caseId, url: `https://t/${c.caseId}` };
    },
    update: async (_t, c, r) => {
      store.set(c.caseId, { c, r });
    },
    suggest: async () => {},
    markObsolete: async (t) => {
      const e = store.get(t.caseId);
      if (e) store.set(t.caseId, { ...e, c: { ...e.c, lifecycle: 'obsolete' } });
    },
    publishSummary: async () => ({}),
  };
}

const verifyResult = (over: Partial<VerifyResult> = {}): VerifyResult => ({
  statuses: [
    {
      caseId: 'shop-12-C01',
      status: 'implemented',
      evidence: 'coupon.ts의 isExpired가 처리',
      files: ['src/coupon.ts'],
    },
    {
      caseId: 'shop-12-C02',
      status: 'missing',
      evidence: 'coupon.ts에 동시 적용 잠금 없음',
      files: ['src/coupon.ts'],
    },
  ],
  newCases: [
    {
      title: '쿠폰 적용 API 재시도 시 중복 차감',
      acLabels: [],
      technique: 'idempotency',
      priority: 'P0',
      preconditions: ['쿠폰 1장 보유'],
      testData: ['쿠폰 = DUP1'],
      steps: ['적용 요청 2회 연속 전송'],
      expected: ['차감 1회'],
      whyEasyToMiss: '기획서에 재시도 정의 없음',
      origin: 'code',
    },
  ],
  alignment: {
    status: 'partial',
    summary: 'AC2 미구현',
    findings: [],
  } as unknown as VerifyResult['alignment'],
  usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
  costUsd: 0.1,
  calls: 1,
  warnings: [],
  ...over,
});

function cfg(extra: Record<string, string> = {}): QtgConfig {
  return resolveConfig(inputs({ 'anthropic-api-key': 'sk', ...extra }), parseRepoConfig(null));
}

function makeDeps(sink: CaseSink, over: Partial<VerifyDeps> = {}) {
  const writes: string[] = [];
  const saved: string[] = [];
  const deps: VerifyDeps = {
    logger: silentLogger(),
    github: {
      listChangedFiles: vi.fn(async () => []),
      listPathsChangedBetween: vi.fn(async () => []),
    } as unknown as VerifyDeps['github'],
    commentStore: {
      load: vi.fn(async () => ({ commentId: null, state: { v: 1 as const }, warnings: [] })),
      save: vi.fn(async (_pr, _id, body: string) => {
        saved.push(body);
        return { commentId: 1, url: 'u' };
      }),
    },
    prdProviders: [],
    extractPrdRefs: vi.fn((body: string) => (body.includes('#12') ? [specRef] : [])),
    collectPrdDocuments: vi.fn(async (refs: PrdRef[]) => ({
      documents: refs.map((ref) => ({
        ref,
        title: '쿠폰',
        bodyMarkdown: 'AC1',
        acceptanceCriteria: ['AC1'],
        url: 'u',
        meta: {},
      })),
      warnings: [],
    })),
    preprocessEngine: {
      run: vi.fn(async () => ({ chunks: [], prdDocuments: [], skipped: [], redactions: [], mode: 'single' })),
    } as unknown as VerifyDeps['preprocessEngine'],
    isNoisePath: () => false,
    redactText: (t: string) => ({ text: t, redactions: [] }),
    llm: { id: 'fake', generateReport: vi.fn(), mergeReports: vi.fn(), estimateCostUsd: () => 0 },
    verifyCases: vi.fn(async () => verifyResult()),
    applyVerify,
    planSync,
    renderCase,
    sinks: [sink],
    runPlan: vi.fn(async (): Promise<PlanOutcome> => {
      throw new Error('not expected');
    }),
    renderComment: (d) => `comment ${d.cases.length} ${d.newCaseIds.join(',')}`,
    renderSummary: (d) => `summary ${d.alignment.status}`,
    writeSummary: async (m) => {
      writes.push(m);
    },
    now: () => 0,
    ...over,
  };
  return { deps, writes, saved };
}

describe('runVerify (SPEC v3 §2.2)', () => {
  it('returns no_spec when the PR links no spec, so the adapter can fall back to v2', async () => {
    const { deps } = makeDeps(memorySink());
    const out = await runVerify(deps, cfg(), { ...pr, body: 'no link' }, { name: 'pull_request' }, signal);
    expect(out).toEqual({ kind: 'no_spec' });
    expect(deps.verifyCases).not.toHaveBeenCalled();
  });

  it('sets code status per case, adds code-derived cases, syncs tickets and writes one PR comment', async () => {
    const sink = memorySink([baseCase(1), baseCase(2, { title: '동시 적용', technique: 'concurrency' })]);
    const { deps, writes, saved } = makeDeps(sink);
    const out = await runVerify(deps, cfg(), pr, { name: 'pull_request', action: 'labeled' }, signal);
    if (out.kind !== 'verified') throw new Error(out.kind);

    expect(out.status).toBe('ok');
    expect(out.cases.find((c) => c.caseId === 'shop-12-C01')?.codeStatus).toMatchObject({
      status: 'implemented',
      sha: pr.headSha,
    });
    expect(out.cases.find((c) => c.caseId === 'shop-12-C02')?.codeStatus?.status).toBe('missing');
    expect(out.newCaseIds).toEqual(['shop-12-C03']);
    expect(sink.store.get('shop-12-C03')?.c.origin).toBe('code');
    expect(out.sinks[0]).toMatchObject({ kind: 'github-issue', ok: true, created: 1, updated: 2 });
    expect(saved).toEqual(['comment 3 shop-12-C03']);
    expect(writes).toEqual(['summary partial']);
    expect(out.failed).toBe(false);
    // only active cases go to the model
    const req = vi.mocked(deps.verifyCases).mock.calls[0]?.[0];
    expect(req?.cases.map((c) => c.caseId)).toEqual(['shop-12-C01', 'shop-12-C02']);
  });

  it('runs the plan phase first when the spec has no cases yet', async () => {
    const sink = memorySink();
    const runPlan = vi.fn(async (): Promise<PlanOutcome> => {
      await sink.create(specRef, baseCase(1), renderCase(baseCase(1), 'ko'), signal);
      await sink.create(specRef, baseCase(2), renderCase(baseCase(2), 'ko'), signal);
      return {
        status: 'ok',
        spec: specRef,
        cases: [baseCase(1), baseCase(2)],
        sinks: [],
        costUsd: 0.3,
        styleViolations: 0,
        warnings: [],
      };
    });
    const { deps } = makeDeps(sink, { runPlan });
    const out = await runVerify(deps, cfg(), pr, { name: 'pull_request' }, signal);
    if (out.kind !== 'verified') throw new Error(out.kind);
    expect(runPlan).toHaveBeenCalledOnce();
    expect(out.costUsd).toBeCloseTo(0.4);
    // the plan's tickets are known, so verify updates them instead of creating duplicates
    expect(out.sinks[0]).toMatchObject({ created: 1, updated: 2 });
    expect(sink.store.size).toBe(3);
  });

  it('a second identical run changes nothing (no duplicate tickets)', async () => {
    const sink = memorySink([baseCase(1), baseCase(2, { title: '동시 적용', technique: 'concurrency' })]);
    const { deps } = makeDeps(sink);
    await runVerify(deps, cfg(), pr, { name: 'pull_request' }, signal);
    const again = await runVerify(deps, cfg(), pr, { name: 'pull_request' }, signal);
    if (again.kind !== 'verified') throw new Error(again.kind);
    expect(again.sinks[0]).toMatchObject({ created: 0, updated: 0, unchanged: 3 });
    expect(sink.store.size).toBe(3);
  });

  it('dry-run writes no PR comment and keeps only the file sink', async () => {
    const sink = memorySink([baseCase(1)]);
    const { deps, saved, writes } = makeDeps(sink);
    const out = await runVerify(deps, cfg({ 'dry-run': 'true' }), pr, { name: 'pull_request' }, signal);
    if (out.kind !== 'verified') throw new Error(out.kind);
    expect(saved).toEqual([]);
    expect(out.sinks).toEqual([]);
    expect(writes).toHaveLength(1);
  });

  it('skips noise-only pushes since the last analyzed SHA (TRG-04)', async () => {
    const { deps } = makeDeps(memorySink([baseCase(1)]), {
      commentStore: {
        load: vi.fn(async () => ({
          commentId: 1,
          state: { v: 1 as const, sha: 'c'.repeat(40) },
          warnings: [],
        })),
        save: vi.fn(),
      },
    });
    deps.github.listPathsChangedBetween = vi.fn(async () => ['README.md']);
    deps.isNoisePath = () => true;
    const out = await runVerify(deps, cfg(), pr, { name: 'pull_request', action: 'synchronize' }, signal);
    expect(out).toEqual({ kind: 'skipped', reason: 'no_logic_change' });
  });

  it('fails the check on fail-on and reports model errors without throwing', async () => {
    const { deps } = makeDeps(memorySink([baseCase(1)]));
    const out = await runVerify(deps, cfg({ 'fail-on': 'partial' }), pr, { name: 'pull_request' }, signal);
    expect(out).toMatchObject({ kind: 'verified', failed: true });

    const broken = makeDeps(memorySink([baseCase(1)]), {
      verifyCases: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const err = await runVerify(broken.deps, cfg(), pr, { name: 'pull_request' }, signal);
    expect(err).toMatchObject({ kind: 'verified', status: 'error' });
    expect(broken.writes[0]).toMatch(/check failed/);
  });

  it('skips the jira sink for a non-Jira spec with a warning (§5)', async () => {
    const jira = { ...memorySink([baseCase(1)]), kind: 'jira' as const };
    const gh = memorySink([baseCase(1)]);
    const { deps } = makeDeps(gh, { sinks: [jira, gh] });
    const out = await runVerify(deps, cfg(), pr, { name: 'pull_request' }, signal);
    if (out.kind !== 'verified') throw new Error(out.kind);
    expect(out.sinks.map((s) => s.kind)).toEqual(['github-issue']);
    expect(out.warnings.some((w) => /jira sink was skipped/.test(w.message))).toBe(true);
  });
});
