import { describe, expect, it } from 'vitest';
import type { OrchestrateOptions, QaReport } from '../../src/core/contracts';
import { QtgError } from '../../src/core/errors';
import { normalizeReport, orchestrate } from '../../src/llm/orchestrate';
import { billedError } from '../../src/llm/usage';
import { fakeReport } from '../helpers/fakes';
import { chunk, fakeProvider, preOutput, promptContext, result, usage } from './support';

// expectedOutputTokens is kept small so the default cap comfortably covers a few calls.
const OPTIONS: OrchestrateOptions = { maxCostUsd: 2, concurrency: 3, expectedOutputTokens: 4_000 };
const signal = () => new AbortController().signal;
const scenario = (overrides: Partial<QaReport['scenarios'][number]>) => ({
  ...(fakeReport().scenarios[0] as QaReport['scenarios'][number]),
  ...overrides,
});

describe('orchestrate', () => {
  it('LLM-07 single mode makes exactly one call and no merge', async () => {
    const { provider, generateCalls, mergeCalls } = fakeProvider();
    const pre = preOutput([chunk('c1', ['src/coupon.ts'])]);
    const res = await orchestrate(pre, provider, promptContext(), OPTIONS, signal());

    expect(generateCalls).toHaveLength(1);
    expect(generateCalls[0]?.phase).toBe('single');
    expect(generateCalls[0]?.skipped).toEqual(pre.skipped);
    expect(mergeCalls).toHaveLength(0);
    expect(res.calls).toBe(1);
    expect(res.usage).toEqual(usage(1_000, 500));
    expect(res.costUsd).toBeCloseTo((1_000 * 4 + 500 * 20) / 1e6, 9);
    expect(res.skipped).toEqual([]);
    expect(res.warnings).toEqual([]);
  });

  it('LLM-07 map-reduce runs one map call per chunk, then one merge over the partials in chunk order', async () => {
    const { provider, generateCalls, mergeCalls } = fakeProvider();
    const pre = preOutput([chunk('c1', ['a.ts']), chunk('c2', ['b.ts']), chunk('c3', ['c.ts'])]);
    const res = await orchestrate(pre, provider, promptContext(), OPTIONS, signal());

    expect(generateCalls.map((c) => [c.phase, c.chunk.id])).toEqual([
      ['map', 'c1'],
      ['map', 'c2'],
      ['map', 'c3'],
    ]);
    // Each map call lists the files it cannot see (other chunks + preprocess skips).
    expect(generateCalls[0]?.skipped.map((s) => s.path)).toEqual(['package-lock.json', 'b.ts', 'c.ts']);
    expect(mergeCalls).toHaveLength(1);
    expect(mergeCalls[0]?.partials.map((p) => p.summary)).toEqual(['part c1', 'part c2', 'part c3']);
    expect(res.report.summary).toBe('merged');
    expect(res.calls).toBe(4);
    expect(res.usage).toEqual(usage(4_000, 2_000));
  });

  it('LLM-07 never runs more map calls at once than options.concurrency', async () => {
    let inFlight = 0;
    let peak = 0;
    const { provider, generateCalls } = fakeProvider(async (req) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return result(fakeReport({ summary: req.chunk.id }));
    });
    const pre = preOutput(Array.from({ length: 7 }, (_, i) => chunk(`c${i}`, [`f${i}.ts`], 1_000)));
    await orchestrate(pre, provider, promptContext(), { ...OPTIONS, concurrency: 2 }, signal());
    expect(generateCalls).toHaveLength(7);
    expect(peak).toBe(2);
  });

  it('LLM-10 drops the lowest-priority chunks before calling when the estimate exceeds max-cost-usd', async () => {
    const { provider, generateCalls, mergeCalls } = fakeProvider();
    // Each map call ≈ (shared + 100K) * $4/M + 4K * $20/M ≈ $0.48; three plus a reduce exceed $1.20.
    const pre = preOutput([
      chunk('c1', ['a.ts'], 100_000),
      chunk('c2', ['b.ts'], 100_000),
      chunk('c3', ['c.ts', 'd.ts'], 100_000),
    ]);
    const res = await orchestrate(pre, provider, promptContext(), { ...OPTIONS, maxCostUsd: 1.2 }, signal());

    expect(generateCalls.map((c) => c.chunk.id)).toEqual(['c1', 'c2']);
    expect(mergeCalls).toHaveLength(1);
    expect(res.skipped).toEqual([
      { path: 'c.ts', reason: 'cost_cap' },
      { path: 'd.ts', reason: 'cost_cap' },
    ]);
    expect(res.warnings.filter((w) => w.code === 'cost_cap')).toEqual([
      {
        code: 'cost_cap',
        message: expect.stringMatching(
          /^2 lower-priority file\(s\).*estimated cost exceeded max-cost-usd \(\$1\.20\)/,
        ),
      },
    ]);
    // The model is told about the dropped files so it can flag the coverage gap.
    expect(generateCalls[0]?.skipped).toContainEqual({ path: 'c.ts', reason: 'cost_cap' });
  });

  it('LLM-10 falls back to a single call (no merge) when only the top chunk fits the budget', async () => {
    const { provider, generateCalls, mergeCalls } = fakeProvider();
    const pre = preOutput([chunk('c1', ['a.ts'], 100_000), chunk('c2', ['b.ts'], 100_000)]);
    const res = await orchestrate(pre, provider, promptContext(), { ...OPTIONS, maxCostUsd: 0.6 }, signal());
    expect(generateCalls).toHaveLength(1);
    expect(generateCalls[0]?.phase).toBe('single');
    expect(mergeCalls).toHaveLength(0);
    expect(res.skipped).toEqual([{ path: 'b.ts', reason: 'cost_cap' }]);
  });

  it('LLM-10 makes no LLM call and fails with cost_cap when even the top chunk exceeds max-cost-usd', async () => {
    const { provider, generateCalls, mergeCalls } = fakeProvider();
    // (shared prompt + PRD + 100K code) * $4/M + 4K * $20/M ≈ $0.49 for the top chunk alone.
    const pre = preOutput([chunk('c1', ['a.ts'], 100_000), chunk('c2', ['b.ts'], 100_000)]);
    const err = await orchestrate(
      pre,
      provider,
      promptContext(),
      { ...OPTIONS, maxCostUsd: 0.4 },
      signal(),
    ).then(
      () => null,
      (e: unknown) => e as QtgError,
    );
    expect(err).toBeInstanceOf(QtgError);
    expect(err?.code).toBe('cost_cap');
    expect(err?.userMessage).toMatch(/\(~\$0\.49\) exceeds max-cost-usd \(\$0\.40\)/);
    expect(err?.userMessage).toContain('Raise max-cost-usd');
    expect(err?.usage).toBeUndefined();
    expect(generateCalls).toHaveLength(0);
    expect(mergeCalls).toHaveLength(0);
  });

  it('LLM-10 runs when the estimate is exactly within the cap', async () => {
    const { provider, generateCalls } = fakeProvider();
    const pre = preOutput([chunk('c1', ['a.ts'], 100_000)]);
    await orchestrate(pre, provider, promptContext(), { ...OPTIONS, maxCostUsd: 0.5 }, signal());
    expect(generateCalls).toHaveLength(1);
  });

  it('LLM-10 stops starting map calls once the actual spend reaches the cap and merges the partial reports', async () => {
    // Estimates are tiny, real usage is large: every call really costs $0.50.
    const { provider, generateCalls, mergeCalls } = fakeProvider((req) =>
      result(fakeReport({ summary: req.chunk.id }), usage(100_000, 5_000)),
    );
    const pre = preOutput(Array.from({ length: 5 }, (_, i) => chunk(`c${i}`, [`f${i}.ts`], 1_000)));
    const res = await orchestrate(
      pre,
      provider,
      promptContext(),
      { ...OPTIONS, maxCostUsd: 1, concurrency: 1 },
      signal(),
    );

    expect(generateCalls.map((c) => c.chunk.id)).toEqual(['c0', 'c1']);
    expect(mergeCalls[0]?.partials.map((p) => p.summary)).toEqual(['c0', 'c1']);
    expect(res.skipped.map((s) => s.path)).toEqual(['f2.ts', 'f3.ts', 'f4.ts']);
    expect(res.warnings.filter((w) => w.code === 'cost_cap')).toEqual([
      { code: 'cost_cap', message: expect.stringContaining('the run reached max-cost-usd ($1.00)') },
    ]);
    expect(res.calls).toBe(3);
  });

  it('LLM-10 uses the lone partial as the report when the cap stops the run after one map call', async () => {
    const { provider, mergeCalls } = fakeProvider((req) =>
      result(fakeReport({ summary: req.chunk.id }), usage(300_000, 5_000)),
    );
    const pre = preOutput([chunk('c0', ['a.ts'], 1_000), chunk('c1', ['b.ts'], 1_000)]);
    const res = await orchestrate(
      pre,
      provider,
      promptContext(),
      { ...OPTIONS, maxCostUsd: 1, concurrency: 1 },
      signal(),
    );
    expect(mergeCalls).toHaveLength(0);
    expect(res.report.summary).toBe('c0');
    expect(res.skipped).toEqual([{ path: 'b.ts', reason: 'cost_cap' }]);
  });

  it('LLM-10 warns when a single call ends up costing more than the cap', async () => {
    const { provider } = fakeProvider(() => result(fakeReport(), usage(600_000, 5_000)));
    const res = await orchestrate(
      preOutput([chunk('c1', ['a.ts'], 1_000)]),
      provider,
      promptContext(),
      OPTIONS,
      signal(),
    );
    expect(res.warnings.filter((w) => w.code === 'cost_cap')).toEqual([
      { code: 'cost_cap', message: expect.stringMatching(/cost about \$2\.50, above max-cost-usd/) },
    ]);
  });

  it('LLM-04 retries a truncated reply once with half the scenario cap and counts both calls', async () => {
    let attempt = 0;
    const { provider, generateCalls } = fakeProvider(() => {
      attempt += 1;
      if (attempt === 1) throw billedError('llm_truncated', 'cut off', usage(1_000, 32_000));
      return result(fakeReport());
    });
    const res = await orchestrate(
      preOutput([chunk('c1', ['src/coupon.ts'])]),
      provider,
      promptContext({ maxScenarios: 20 }),
      OPTIONS,
      signal(),
    );
    expect(generateCalls.map((c) => c.context.maxScenarios)).toEqual([20, 10]);
    expect(res.calls).toBe(2);
    expect(res.usage).toEqual(usage(2_000, 32_500));
  });

  it('LLM-04 gives up with llm_truncated when the retry is cut off too', async () => {
    const { provider, generateCalls } = fakeProvider(() => {
      throw billedError('llm_truncated', 'cut off', usage(1, 1));
    });
    await expect(
      orchestrate(
        preOutput([chunk('c1', ['a.ts'])]),
        provider,
        promptContext({ maxScenarios: 1 }),
        OPTIONS,
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'llm_truncated' });
    expect(generateCalls.map((c) => c.context.maxScenarios)).toEqual([1, 1]);
  });

  it('LLM-04 also retries a truncated merge call', async () => {
    let merges = 0;
    const { provider, mergeCalls } = fakeProvider(undefined, () => {
      merges += 1;
      if (merges === 1) throw billedError('llm_truncated', 'cut off', usage(1, 1));
      return result(fakeReport({ summary: 'merged on retry' }));
    });
    const pre = preOutput([chunk('c1', ['a.ts']), chunk('c2', ['b.ts'])]);
    const res = await orchestrate(pre, provider, promptContext({ maxScenarios: 9 }), OPTIONS, signal());
    expect(mergeCalls.map((c) => c.context.maxScenarios)).toEqual([9, 4]);
    expect(res.report.summary).toBe('merged on retry');
    expect(res.calls).toBe(4);
  });

  it('LLM-08 a failed run reports everything billed so far: finished map calls plus the failing call', async () => {
    const { provider } = fakeProvider(async (req) => {
      if (req.chunk.id === 'c1') return result(fakeReport(), usage(10_000, 1_000));
      if (req.chunk.id === 'c2') return result(fakeReport(), usage(20_000, 2_000));
      throw billedError('llm_refusal', 'declined', usage(30_000, 0));
    });
    const pre = preOutput([chunk('c1', ['a.ts']), chunk('c2', ['b.ts']), chunk('c3', ['c.ts'])]);
    const err = await orchestrate(
      pre,
      provider,
      promptContext(),
      { ...OPTIONS, concurrency: 1 },
      signal(),
    ).then(
      () => null,
      (e: unknown) => e as QtgError,
    );
    expect(err?.code).toBe('llm_refusal');
    expect(err?.userMessage).toBe('declined');
    expect(err?.usage).toEqual(usage(60_000, 3_000));
  });

  it('LLM-08 a failed merge reports the map calls and both merge attempts', async () => {
    const { provider } = fakeProvider(
      () => result(fakeReport(), usage(10_000, 1_000)),
      () => {
        throw billedError('llm_truncated', 'cut off', usage(5_000, 32_000));
      },
    );
    const pre = preOutput([chunk('c1', ['a.ts']), chunk('c2', ['b.ts'])]);
    const err = await orchestrate(pre, provider, promptContext(), OPTIONS, signal()).then(
      () => null,
      (e: unknown) => e as QtgError,
    );
    expect(err?.code).toBe('llm_truncated');
    expect(err?.usage).toEqual(usage(30_000, 66_000));
  });

  it('LLM-08 wraps an unexpected error as internal when calls were already billed, keeping the cause', async () => {
    const bug = new TypeError('bug');
    const { provider } = fakeProvider(async (req) => {
      if (req.chunk.id === 'c1') return result(fakeReport(), usage(10_000, 1_000));
      throw bug;
    });
    const pre = preOutput([chunk('c1', ['a.ts']), chunk('c2', ['b.ts'])]);
    const err = await orchestrate(
      pre,
      provider,
      promptContext(),
      { ...OPTIONS, concurrency: 1 },
      signal(),
    ).then(
      () => null,
      (e: unknown) => e as QtgError,
    );
    expect(err).toBeInstanceOf(QtgError);
    expect(err?.code).toBe('internal');
    expect(err?.cause).toBe(bug);
    expect(err?.usage).toEqual(usage(10_000, 1_000));
  });

  it('SPEC §10 a failing map call aborts its siblings and fails the run with that error', async () => {
    const aborted: string[] = [];
    const { provider, mergeCalls } = fakeProvider(async (req, sig) => {
      if (req.chunk.id === 'c1') throw new QtgError('llm_refusal', 'declined');
      await new Promise<void>((resolve) => {
        sig.addEventListener('abort', () => {
          aborted.push(req.chunk.id);
          resolve();
        });
      });
      throw new QtgError('cancelled', 'cancelled');
    });
    const pre = preOutput([chunk('c1', ['a.ts']), chunk('c2', ['b.ts']), chunk('c3', ['c.ts'])]);
    await expect(orchestrate(pre, provider, promptContext(), OPTIONS, signal())).rejects.toMatchObject({
      code: 'llm_refusal',
    });
    expect(aborted.sort()).toEqual(['c2', 'c3']);
    expect(mergeCalls).toHaveLength(0);
  });

  it('SPEC §10 reports cancellation: before the first call and when the caller aborts mid-run', async () => {
    const pre = preOutput([chunk('c1', ['a.ts'])]);
    const early = new AbortController();
    early.abort();
    const a = fakeProvider();
    await expect(orchestrate(pre, a.provider, promptContext(), OPTIONS, early.signal)).rejects.toMatchObject({
      code: 'cancelled',
    });
    expect(a.generateCalls).toHaveLength(0);

    const mid = new AbortController();
    const b = fakeProvider(async () => {
      mid.abort();
      throw new Error('socket hang up');
    });
    await expect(orchestrate(pre, b.provider, promptContext(), OPTIONS, mid.signal)).rejects.toMatchObject({
      code: 'cancelled',
    });

    const c = fakeProvider(() => {
      throw new TypeError('bug');
    });
    await expect(orchestrate(pre, c.provider, promptContext(), OPTIONS, signal())).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(
      orchestrate(preOutput([]), c.provider, promptContext(), OPTIONS, signal()),
    ).rejects.toMatchObject({ code: 'internal' });
  });

  it('SPEC §7 normalizes the final report against the real changed files (analyzed, renamed-from and skipped)', async () => {
    const report = fakeReport({
      scenarios: [
        scenario({ relatedFiles: ['src/coupon.ts', 'old/coupon.ts', 'package-lock.json', 'src/made-up.ts'] }),
      ],
    });
    const { provider } = fakeProvider(() => result(report));
    const c = chunk('c1', ['src/coupon.ts']);
    (c.files[0] as (typeof c.files)[number]).previousPath = 'old/coupon.ts';
    const res = await orchestrate(preOutput([c]), provider, promptContext(), OPTIONS, signal());
    expect(res.report.scenarios[0]?.relatedFiles).toEqual([
      'src/coupon.ts',
      'old/coupon.ts',
      'package-lock.json',
    ]);
    expect(res.warnings).toEqual([
      { code: 'invalid_related_file', message: expect.stringContaining('Removed 1 file reference') },
    ]);
  });
});

describe('normalizeReport (SPEC §7)', () => {
  const changedPaths = new Set(['src/coupon.ts', 'src/cart.ts']);
  const base = { changedPaths, maxScenarios: 20, hasPrd: true };

  it('SPEC §7 removes file references outside the PR from scenarios, findings and risks, with one warning', () => {
    const input = fakeReport({
      scenarios: [scenario({ relatedFiles: ['./src/coupon.ts', 'src/coupon.ts', 'README.md'] })],
      risks: [{ title: 'r', severity: 'low', description: 'd', files: ['src/cart.ts', '/etc/passwd'] }],
    });
    (input.prdAlignment.findings[0] as QaReport['prdAlignment']['findings'][number]).files = ['lib/ghost.ts'];
    const { report, warnings } = normalizeReport(input, base);
    expect(report.scenarios[0]?.relatedFiles).toEqual(['src/coupon.ts']);
    expect(report.prdAlignment.findings[0]?.files).toEqual([]);
    expect(report.risks[0]?.files).toEqual(['src/cart.ts']);
    expect(warnings).toEqual([
      { code: 'invalid_related_file', message: expect.stringContaining('Removed 4 file reference(s)') },
    ]);
  });

  it('SPEC §7 sorts scenarios P0 → P2 (stable), cuts to max-scenarios and renumbers from TC-01', () => {
    const input = fakeReport({
      scenarios: [
        scenario({ id: 'x', title: 'p2-a', priority: 'P2' }),
        scenario({ id: 'y', title: 'p0-a', priority: 'P0' }),
        scenario({ id: 'z', title: 'p1-a', priority: 'P1' }),
        scenario({ id: 'w', title: 'p0-b', priority: 'P0' }),
      ],
    });
    const { report } = normalizeReport(input, { ...base, maxScenarios: 3 });
    expect(report.scenarios.map((s) => [s.id, s.title])).toEqual([
      ['TC-01', 'p0-a'],
      ['TC-02', 'p0-b'],
      ['TC-03', 'p1-a'],
    ]);
  });

  it('SPEC §7 forces no_prd with empty findings when no PRD document was available', () => {
    const { report, warnings } = normalizeReport(fakeReport(), { ...base, hasPrd: false });
    expect(report.prdAlignment).toEqual({ status: 'no_prd', findings: [] });
    expect(warnings).toEqual([]);
  });

  it.each([
    [['covered', 'covered'], 'aligned'],
    [['covered', 'missing'], 'partial'],
    [['covered', 'unclear'], 'partial'],
    [['missing', 'contradicts'], 'misaligned'],
  ] as const)('SPEC §8 derives the overall status from findings %j → %s', (statuses, expected) => {
    const template = fakeReport().prdAlignment.findings[0] as QaReport['prdAlignment']['findings'][number];
    const input = fakeReport({
      prdAlignment: { status: 'aligned', findings: statuses.map((status) => ({ ...template, status })) },
    });
    const { report, warnings } = normalizeReport(input, base);
    expect(report.prdAlignment.status).toBe(expected);
    expect(warnings.some((w) => w.code === 'other')).toBe(expected !== 'aligned');
  });

  it('SPEC §7 replaces a "no_prd" verdict with "partial" when a PRD is linked but nothing was judged', () => {
    const input = fakeReport({ prdAlignment: { status: 'no_prd', findings: [] } });
    expect(normalizeReport(input, base).report.prdAlignment.status).toBe('partial');
    const kept = fakeReport({ prdAlignment: { status: 'aligned', findings: [] } });
    expect(normalizeReport(kept, base).report.prdAlignment.status).toBe('aligned');
  });
});
