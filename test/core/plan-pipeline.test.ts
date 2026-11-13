import { describe, expect, it, vi } from 'vitest';
import type {
  CaseSink,
  ExistingCaseTicket,
  PlannedCase,
  QaCase,
  SinkKind,
  SyncOp,
} from '../../src/core/cases';
import { parseRepoConfig, type QtgConfig, resolveConfig } from '../../src/core/config';
import type { PrdRef } from '../../src/core/contracts';
import {
  type PlanDeps,
  primarySink,
  runPlan,
  specDigestOf,
  specUnchanged,
} from '../../src/core/plan-pipeline';
import { inputs, silentLogger } from '../helpers/fakes';

const spec: PrdRef = { source: 'jira', id: 'PROJ-123', raw: 'PROJ-123' };
const signal = new AbortController().signal;

const planned = (title: string, reuse: string | null = null): PlannedCase => ({
  title,
  acLabels: ['AC1'],
  technique: 'boundary',
  priority: 'P0',
  preconditions: ['쿠폰 미사용 회원'],
  testData: ['code = EXP1'],
  steps: ['결제 화면 진입', '쿠폰 적용'],
  expected: ['적용 거부'],
  whyEasyToMiss: '만료 시각 포함 여부 정의 없음',
  origin: 'spec',
  reuseCaseId: reuse,
});

function fakeSink(kind: SinkKind, existing: ExistingCaseTicket[] = [], fail = false) {
  const calls: string[] = [];
  const sink: CaseSink = {
    kind,
    isConfigured: () => true,
    list: vi.fn(async () => existing),
    create: vi.fn(async (_s, c: QaCase) => {
      calls.push(`create:${c.caseId}`);
      if (fail) throw new Error('boom');
      return { ticketRef: c.caseId, url: `https://${kind}/${c.caseId}` };
    }),
    update: vi.fn(async (_t, c: QaCase) => {
      calls.push(`update:${c.caseId}`);
    }),
    suggest: vi.fn(async () => {}),
    markObsolete: vi.fn(async (t: ExistingCaseTicket) => {
      calls.push(`obsolete:${t.caseId}`);
    }),
    publishSummary: vi.fn(async () => ({ url: `https://${kind}/summary` })),
  };
  return { sink, calls };
}

function cfg(extra: Record<string, string> = {}): QtgConfig {
  return resolveConfig(inputs({ 'anthropic-api-key': 'sk', ...extra }), parseRepoConfig(null));
}

function makeDeps(sinks: CaseSink[], over: Partial<PlanDeps> = {}): PlanDeps {
  return {
    logger: silentLogger(),
    prdProviders: [],
    collectPrdDocuments: vi.fn(async (refs: PrdRef[]) => ({
      documents: refs.map((ref) => ({
        ref,
        title: '쿠폰 적용',
        bodyMarkdown: '토큰 ghp_SECRET 포함',
        acceptanceCriteria: ['AC1: 만료 쿠폰 거부'],
        url: 'u',
        meta: {},
      })),
      warnings: [],
    })),
    redactText: (t: string) => ({ text: t.replace('ghp_SECRET', '[REDACTED:github_token]'), redactions: [] }),
    llm: { id: 'fake-model', generateReport: vi.fn(), mergeReports: vi.fn(), estimateCostUsd: () => 0.5 },
    generatePlan: vi.fn(async () => ({
      cases: [
        planned('만료 1초 지난 쿠폰 적용 시 거부'),
        planned('만료 정각 쿠폰 적용 시 거부', 'PROJ-123-C01'),
      ],
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: 0.42,
      calls: 1,
      warnings: [],
      dropped: 0,
    })),
    reconcileCases: vi.fn((specRef: string, _existing, plannedCases: PlannedCase[]) => ({
      cases: plannedCases.map((p, i) => ({
        ...p,
        caseId: p.reuseCaseId ?? `${specRef}-C${String(i + 2).padStart(2, '0')}`,
        specRef,
        lifecycle: 'active' as const,
      })),
      warnings: [],
    })),
    planSync: vi.fn((existing: ExistingCaseTicket[], next: QaCase[]): SyncOp[] =>
      next.map((c) => {
        const t = existing.find((e) => e.caseId === c.caseId);
        return t ? { op: 'update' as const, ticket: t, case: c } : { op: 'create' as const, case: c };
      }),
    ),
    renderCase: (c: QaCase) => ({ title: c.title, markdown: c.title, fields: {}, hash: 'h' }),
    lintCaseStyle: vi.fn(() => []),
    sinks,
    ...over,
  };
}

const existingTicket: ExistingCaseTicket = {
  caseId: 'PROJ-123-C01',
  ticketRef: 'PROJ-200',
  url: 'https://jira/PROJ-200',
  lastWritten: null,
  writtenHash: 'h',
  currentHash: 'h',
  human: { execStatus: 'Pass' },
};

describe('primarySink', () => {
  it('prefers jira > notion > github-issue > file among configured sinks', () => {
    const file = fakeSink('file').sink;
    const gh = fakeSink('github-issue').sink;
    const jira = fakeSink('jira').sink;
    expect(primarySink([file, gh])?.kind).toBe('github-issue');
    expect(primarySink([file, gh, jira])?.kind).toBe('jira');
    expect(primarySink([file])?.kind).toBe('file');
    expect(primarySink([{ ...jira, isConfigured: () => false }])).toBeNull();
  });
});

describe('runPlan', () => {
  it('generates cases from the redacted spec, reuses ids from the primary sink and syncs every sink', async () => {
    const jira = fakeSink('jira', [existingTicket]);
    const file = fakeSink('file');
    const deps = makeDeps([file.sink, jira.sink]);
    const out = await runPlan(deps, cfg({ sinks: 'jira,file' }), spec, signal);

    expect(out.status).toBe('ok');
    expect(out.cases.map((c) => c.caseId)).toEqual(['PROJ-123-C02', 'PROJ-123-C01']);
    // spec text reaches the model redacted, and existing ids from the primary (jira) sink are offered
    const req = vi.mocked(deps.generatePlan).mock.calls[0]?.[0];
    expect(req?.spec.bodyMarkdown).toBe('토큰 [REDACTED:github_token] 포함');
    expect(req?.existing.map((e) => e.caseId)).toEqual(['PROJ-123-C01']);
    expect(req?.maxCases).toBe(80);
    // jira updates the existing case and creates the new one; file creates both
    expect(jira.calls).toEqual(['create:PROJ-123-C02', 'update:PROJ-123-C01']);
    expect(file.calls).toEqual(['create:PROJ-123-C02', 'create:PROJ-123-C01']);
    expect(out.sinks.find((s) => s.kind === 'jira')).toMatchObject({
      ok: true,
      created: 1,
      updated: 1,
      summaryUrl: 'https://jira/summary',
    });
    expect(out.costUsd).toBe(0.42);
    // the primary sink is listed once, not twice
    expect(jira.sink.list).toHaveBeenCalledTimes(1);
  });

  it('keeps going when one sink fails, and reports it', async () => {
    const gh = fakeSink('github-issue', [], true);
    const file = fakeSink('file');
    const out = await runPlan(makeDeps([gh.sink, file.sink]), cfg(), spec, signal);
    expect(out.status).toBe('ok');
    expect(out.sinks.find((s) => s.kind === 'github-issue')).toMatchObject({ ok: false });
    expect(out.sinks.find((s) => s.kind === 'file')).toMatchObject({ ok: true, created: 2 });
  });

  it('fails when every sink fails', async () => {
    const out = await runPlan(
      makeDeps([fakeSink('file', [], true).sink]),
      cfg({ sinks: 'file' }),
      spec,
      signal,
    );
    expect(out).toMatchObject({ status: 'error', error: { code: 'internal' } });
  });

  it('fails clearly when the spec cannot be read or no sink is configured', async () => {
    const noSpec = makeDeps([fakeSink('file').sink], {
      collectPrdDocuments: vi.fn(async () => ({ documents: [], warnings: [] })),
    });
    expect((await runPlan(noSpec, cfg(), spec, signal)).error?.code).toBe('prd_required');
    const none = makeDeps([{ ...fakeSink('file').sink, isConfigured: () => false }]);
    expect((await runPlan(none, cfg(), spec, signal)).error?.code).toBe('config_invalid');
  });

  it('counts style violations on active cases', async () => {
    const deps = makeDeps([fakeSink('file').sink], {
      lintCaseStyle: vi.fn(() => [{ rule: 'banned', text: '보장' }]),
    });
    expect((await runPlan(deps, cfg(), spec, signal)).styleViolations).toBe(2);
  });
});

describe('v3 config', () => {
  it('parses sinks and v3 inputs with defaults', () => {
    const c = cfg();
    expect(c).toMatchObject({
      mode: 'auto',
      planLabel: 'needs-qa-plan',
      sinks: ['github-issue', 'file'],
      maxCases: 80,
      jiraSubtaskType: 'Sub-task',
      spec: null,
    });
    expect(cfg({ sinks: 'jira, notion,jira' }).sinks).toEqual(['jira', 'notion']);
    expect(() => cfg({ sinks: 'slack' })).toThrow(/Unknown sink/);
    expect(() => cfg({ mode: 'review' })).toThrow();
  });
});

describe('spec digest (SPEC v3 §4)', () => {
  const spec0 = {
    title: '쿠폰 적용',
    bodyMarkdown: '토큰 [REDACTED:github_token] 포함',
    acceptanceCriteria: ['AC1: 만료 쿠폰 거부'],
  };

  it('stamps active spec cases with the digest of the redacted spec', async () => {
    const out = await runPlan(makeDeps([fakeSink('file').sink]), cfg(), spec, signal);
    expect(out.cases.every((c) => c.specDigest === specDigestOf(spec0))).toBe(true);
  });

  it('skips generation when every active spec case was planned from the same text', async () => {
    const digest = specDigestOf(spec0);
    const last: QaCase = {
      ...planned('만료 1초 지난 쿠폰 적용 시 거부'),
      caseId: 'PROJ-123-C01',
      specRef: 'PROJ-123',
      lifecycle: 'active',
      specDigest: digest,
    };
    const ticket = { ...existingTicket, lastWritten: last };
    const jira = fakeSink('jira', [ticket]);
    const deps = makeDeps([jira.sink]);
    const out = await runPlan(deps, cfg({ sinks: 'jira' }), spec, signal);
    expect(out).toMatchObject({ status: 'ok', skipped: 'spec_unchanged' });
    expect(out.cases.map((c) => c.caseId)).toEqual(['PROJ-123-C01']);
    expect(deps.generatePlan).not.toHaveBeenCalled();
    expect(jira.calls).toEqual([]);

    const forced = makeDeps([fakeSink('jira', [ticket]).sink]);
    await runPlan(forced, cfg({ sinks: 'jira', 'force-plan': 'true' }), spec, signal);
    expect(forced.generatePlan).toHaveBeenCalledOnce();
  });

  it('plans again when the spec text changed or older cases carry no digest', async () => {
    const old: QaCase = {
      ...planned('x'),
      caseId: 'PROJ-123-C01',
      specRef: 'PROJ-123',
      lifecycle: 'active',
      specDigest: 'stale',
    };
    const a = makeDeps([fakeSink('jira', [{ ...existingTicket, lastWritten: old }]).sink]);
    await runPlan(a, cfg({ sinks: 'jira' }), spec, signal);
    expect(a.generatePlan).toHaveBeenCalledOnce();
    const noDigest: QaCase = { ...old, specDigest: undefined };
    expect(specUnchanged([{ ...existingTicket, lastWritten: noDigest }], specDigestOf(spec0))).toBe(false);
    expect(specUnchanged([], specDigestOf(spec0))).toBe(false);
  });
});

describe('spec digest edge cases (SPEC v3 §4)', () => {
  const spec0 = {
    title: '쿠폰 적용',
    bodyMarkdown: '토큰 [REDACTED:github_token] 포함',
    acceptanceCriteria: ['AC1: 만료 쿠폰 거부'],
  };
  const digest = () => specDigestOf(spec0);
  const caseWith = (id: string, d: string): QaCase => ({
    ...planned(id),
    caseId: id,
    specRef: 'PROJ-123',
    lifecycle: 'active',
    specDigest: d,
  });

  it('ignores tickets a person edited (their payload keeps the older digest)', () => {
    const fresh = { ...existingTicket, caseId: 'A', lastWritten: caseWith('A', digest()) };
    const edited = {
      ...existingTicket,
      caseId: 'B',
      lastWritten: caseWith('B', 'older'),
      currentHash: 'edited:x',
    };
    expect(specUnchanged([fresh, edited], digest())).toBe(true);
    expect(specUnchanged([edited], digest())).toBe(false);
  });

  it('still writes the file sink when generation is skipped', async () => {
    const ticket = { ...existingTicket, lastWritten: caseWith('PROJ-123-C01', digest()) };
    const jira = fakeSink('jira', [ticket]);
    const file = fakeSink('file');
    const out = await runPlan(makeDeps([jira.sink, file.sink]), cfg({ sinks: 'jira,file' }), spec, signal);
    expect(out.skipped).toBe('spec_unchanged');
    expect(file.calls).toEqual(['create:PROJ-123-C01']);
    expect(file.sink.publishSummary).toHaveBeenCalledOnce();
    expect(jira.sink.publishSummary).not.toHaveBeenCalled();
  });
});

describe('case links in the summary (SPEC v3 §5)', () => {
  it('a sink without urls (file) never blanks the ticket link another sink created', async () => {
    const gh = fakeSink('github-issue');
    const file = fakeSink('file');
    file.sink.create = vi.fn(async (_s, c: QaCase) => ({ ticketRef: c.caseId, url: '' }));
    await runPlan(makeDeps([gh.sink, file.sink]), cfg(), spec, signal);
    const summary = vi.mocked(gh.sink.publishSummary).mock.calls[0]?.[1];
    expect(summary?.cases.map((c) => c.url)).toEqual([
      'https://github-issue/PROJ-123-C02',
      'https://github-issue/PROJ-123-C01',
    ]);
  });
});
