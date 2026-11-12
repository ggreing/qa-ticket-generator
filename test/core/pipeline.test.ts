import { describe, expect, it, vi } from 'vitest';
import { parseRepoConfig, type QtgConfig, resolveConfig } from '../../src/core/config';
import type {
  ChangedFile,
  Deliverer,
  DeliveryState,
  PrCommentStore,
  PrdRef,
  PreprocessOutput,
  TriggerEvent,
} from '../../src/core/contracts';
import { QtgError } from '../../src/core/errors';
import { type PipelineDeps, runPipeline } from '../../src/core/pipeline';
import { fakePr, fakeReport, inputs, silentLogger } from '../helpers/fakes';

const file: ChangedFile = {
  path: 'src/coupon.ts',
  status: 'modified',
  additions: 3,
  deletions: 1,
  patchMissing: false,
};
const preOut: PreprocessOutput = {
  mode: 'single',
  chunks: [{ id: 'c1', files: [], estimatedTokens: 100 }],
  prdDocuments: [],
  skipped: [{ path: 'package-lock.json', reason: 'noise' }],
  redactions: [],
  estimatedTokens: 100,
};
const labeled: TriggerEvent = { name: 'pull_request', action: 'labeled', addedLabel: 'needs-ai-qa' };

function cfg(extra: Record<string, string> = {}): QtgConfig {
  return resolveConfig(inputs({ 'anthropic-api-key': 'sk', ...extra }), parseRepoConfig(null));
}

function makeDeps(overrides: Partial<PipelineDeps> = {}) {
  const saved: { body: string; state: DeliveryState; commentId: number | null }[] = [];
  const store: PrCommentStore = {
    load: vi.fn(async () => ({ commentId: 7, state: { v: 1 as const, sha: 'old' }, warnings: [] })),
    save: vi.fn(async (_pr, commentId, body, state) => {
      saved.push({ body, state, commentId });
      return { commentId: commentId ?? 1, url: 'u' };
    }),
  };
  const summary: Deliverer = {
    channel: 'summary',
    deliver: vi.fn(async () => ({ channel: 'summary' as const, ok: true })),
  };
  const slack: Deliverer = {
    channel: 'slack',
    deliver: vi.fn(async () => ({
      channel: 'slack' as const,
      ok: true,
      statePatch: { slack: { channel: 'C1', ts: '1.1', replies: [] } },
    })),
  };
  let t = 0;
  const deps: PipelineDeps = {
    logger: silentLogger(),
    github: {
      getPullRequest: vi.fn(),
      listChangedFiles: vi.fn(async () => [file]),
      getFileContent: vi.fn(),
      getRepoConfigText: vi.fn(),
      listPathsChangedBetween: vi.fn(async () => ['src/coupon.ts']),
    },
    commentStore: store,
    prdProviders: [],
    extractPrdRefs: vi.fn(() => [{ source: 'jira' as const, id: 'PROJ-123', raw: 'PROJ-123' }]),
    collectPrdDocuments: vi.fn(async (refs: PrdRef[]) => ({
      documents: refs.map((ref) => ({
        ref,
        title: 't',
        bodyMarkdown: 'b',
        acceptanceCriteria: [],
        url: 'u',
        meta: {},
      })),
      warnings: [],
    })),
    preprocessEngine: { run: vi.fn(() => preOut) },
    isNoisePath: vi.fn((p: string) => p.endsWith('.lock') || p.endsWith('lock.json')),
    llm: { id: 'fake', generateReport: vi.fn(), mergeReports: vi.fn(), estimateCostUsd: () => 0 },
    orchestrate: vi.fn(async () => ({
      report: fakeReport(),
      usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: 0.12,
      calls: 1,
      skipped: [],
      warnings: [],
    })),
    renderPrComment: vi.fn((final) => `report:${final.status}`),
    summary,
    slack,
    now: () => (t += 1000),
    ...overrides,
  };
  return { deps, saved, store, summary, slack };
}

const signal = new AbortController().signal;

describe('runPipeline', () => {
  it('runs end-to-end, posts Slack before the comment and persists the new SHA + Slack ts', async () => {
    const { deps, saved, slack, summary } = makeDeps();
    const pr = fakePr();
    const { final, failed } = await runPipeline(deps, cfg(), pr, labeled, signal);

    expect(failed).toBe(false);
    expect(final.status).toBe('ok');
    expect(final.meta).toMatchObject({ mode: 'single', costUsd: 0.12, calls: 1, sha: pr.headSha });
    expect(final.meta.skipped).toEqual(preOut.skipped);
    expect(slack.deliver).toHaveBeenCalledOnce();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      commentId: 7,
      body: 'report:ok',
      state: { v: 1, sha: pr.headSha, slack: { channel: 'C1', ts: '1.1', replies: [] } },
    });
    expect(summary.deliver).toHaveBeenCalledOnce();
  });

  it('TRG-04: skips a push that only touched noise files since the last analyzed SHA', async () => {
    const { deps, saved } = makeDeps({
      github: {
        ...makeDeps().deps.github,
        listPathsChangedBetween: vi.fn(async () => ['package-lock.json', 'yarn.lock']),
      },
    });
    const { final } = await runPipeline(
      deps,
      cfg(),
      fakePr(),
      { name: 'pull_request', action: 'synchronize' },
      signal,
    );
    expect(final).toMatchObject({ status: 'skipped', skipReason: 'no_logic_change' });
    expect(deps.orchestrate).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
  });

  it('warns when no PRD is linked and fails when require-prd is set', async () => {
    const noRefs = { extractPrdRefs: vi.fn(() => []) };
    const soft = await runPipeline(makeDeps(noRefs).deps, cfg(), fakePr(), labeled, signal);
    expect(soft.final.status).toBe('ok');
    expect(soft.final.meta.warnings.map((w) => w.code)).toContain('prd_not_linked');

    const hard = await runPipeline(
      makeDeps(noRefs).deps,
      cfg({ 'require-prd': 'true' }),
      fakePr(),
      labeled,
      signal,
    );
    expect(hard.final).toMatchObject({ status: 'error', error: { code: 'prd_required' } });
    expect(hard.failed).toBe(true);
  });

  it('fail-on partial fails the check on a partial alignment', async () => {
    const { failed } = await runPipeline(
      makeDeps().deps,
      cfg({ 'fail-on': 'partial' }),
      fakePr(),
      labeled,
      signal,
    );
    expect(failed).toBe(true);
    const relaxed = await runPipeline(
      makeDeps().deps,
      cfg({ 'fail-on': 'misaligned' }),
      fakePr(),
      labeled,
      signal,
    );
    expect(relaxed.failed).toBe(false);
  });

  it('publishes an error comment on LLM failure but only fails the check with fail-on-error', async () => {
    const boom = { orchestrate: vi.fn(async () => Promise.reject(new Error('boom'))) };
    const a = makeDeps(boom);
    const res = await runPipeline(a.deps, cfg(), fakePr(), labeled, signal);
    expect(res.final).toMatchObject({ status: 'error', error: { code: 'internal' } });
    expect(res.failed).toBe(false);
    expect(a.saved[0]?.body).toBe('report:error');
    expect(a.saved[0]?.state.sha).toBe('old'); // failed run must not advance the analyzed SHA

    const strict = await runPipeline(
      makeDeps(boom).deps,
      cfg({ 'fail-on-error': 'true' }),
      fakePr(),
      labeled,
      signal,
    );
    expect(strict.failed).toBe(true);
  });

  it('reports billed usage from a failed LLM run', async () => {
    const usage = { inputTokens: 50_000, outputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const err = new QtgError('llm_unavailable', 'Anthropic API unavailable.', { usage });
    const { deps } = makeDeps({
      orchestrate: vi.fn(async () => Promise.reject(err)),
      llm: { id: 'fake', generateReport: vi.fn(), mergeReports: vi.fn(), estimateCostUsd: () => 0.22 },
    });
    const { final } = await runPipeline(deps, cfg(), fakePr(), labeled, signal);
    expect(final.status).toBe('error');
    expect(final.meta.usage).toEqual(usage);
    expect(final.meta.costUsd).toBe(0.22);
  });

  it('publishes nothing when the run is cancelled', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { deps, saved, summary, slack } = makeDeps({
      orchestrate: vi.fn(async () => Promise.reject(abort)),
    });
    const { final } = await runPipeline(deps, cfg(), fakePr(), labeled, signal);
    expect(final.error?.code).toBe('cancelled');
    expect(saved).toHaveLength(0);
    expect(slack.deliver).not.toHaveBeenCalled();
    expect(summary.deliver).not.toHaveBeenCalled();
  });

  it('keeps the PR comment when Slack throws (DLV-08)', async () => {
    const { deps, saved } = makeDeps({
      slack: { channel: 'slack', deliver: vi.fn(async () => Promise.reject(new Error('slack down'))) },
    });
    const { final } = await runPipeline(deps, cfg(), fakePr(), labeled, signal);
    expect(saved).toHaveLength(1);
    expect(final.meta.warnings.map((w) => w.code)).toContain('slack_failed');
  });

  it('publishes a no_files result to the PR, skipping the LLM', async () => {
    const empty = { ...preOut, chunks: [] };
    const { deps, saved } = makeDeps({ preprocessEngine: { run: vi.fn(() => empty) } });
    const { final } = await runPipeline(deps, cfg(), fakePr(), labeled, signal);
    expect(final).toMatchObject({ status: 'skipped', skipReason: 'no_files' });
    expect(deps.orchestrate).not.toHaveBeenCalled();
    expect(saved).toHaveLength(1);
  });

  it('dry-run only writes the summary', async () => {
    const { deps, saved, store, slack, summary } = makeDeps();
    await runPipeline(deps, cfg({ 'dry-run': 'true' }), fakePr(), labeled, signal);
    expect(store.load).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
    expect(slack.deliver).not.toHaveBeenCalled();
    expect(summary.deliver).toHaveBeenCalledOnce();
  });
});
