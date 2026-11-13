/**
 * SPEC v3 §5 — the file sink continues from an earlier qa-cases.json: `previous-cases` input / CLI
 * `--previous`, and by default `<out-dir>/qa-cases.json` for the CLI. Runs the real wire `execute`
 * in plan mode with a fake GitHub API and a scripted planner (no network).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cliInputReader, parseArgs } from '../../src/adapters/cli-args';
import { type ExecuteRequest, execute, previousCasesFor } from '../../src/adapters/wire';
import type { PlannedCase, PlanRequest, PlanResult } from '../../src/core/cases';
import { parseRepoConfig, resolveConfig } from '../../src/core/config';
import type { Octokit } from '../../src/core/octokit';
import type { CasesFile } from '../../src/sinks/file';
import { silentLogger } from '../helpers/fakes';

vi.mock('../../src/llm/plan', () => ({ generatePlan: vi.fn() }));
const { generatePlan } = await import('../../src/llm/plan');

const TITLES = [
  '만료 1초 지난 쿠폰 적용 시 거부',
  '같은 쿠폰 두 번째 적용 시 거부',
  '할인액 상한 초과 시 상한 적용',
];

/** A planner that, like the real prompt asks, reuses the id of an existing case with the same title. */
function scriptedPlanner() {
  vi.mocked(generatePlan as unknown as (req: PlanRequest) => Promise<PlanResult>).mockImplementation(
    async (req: PlanRequest): Promise<PlanResult> => {
      const cases: PlannedCase[] = TITLES.map((title, i) => ({
        title,
        acLabels: [`AC${i + 1}`],
        technique: 'boundary',
        priority: i === 0 ? 'P0' : 'P1',
        preconditions: ['로그인 상태'],
        testData: ['쿠폰 EXP1'],
        steps: ['결제 화면 진입', '쿠폰 EXP1 입력 후 적용'],
        expected: ['"만료된 쿠폰입니다" 토스트 노출'],
        whyEasyToMiss: '기획서에 만료 시각 포함 여부 정의 없음',
        origin: 'spec',
        reuseCaseId: req.existing.find((e) => e.title === title)?.caseId ?? null,
      }));
      return {
        cases,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0,
        calls: 1,
        warnings: [],
        dropped: 0,
      };
    },
  );
}

function fakeOctokit(): Octokit {
  const notFound = Object.assign(new Error('Not Found'), { status: 404 });
  return {
    rest: {
      repos: {
        get: vi.fn(async () => ({ data: { default_branch: 'main' } })),
        getContent: vi.fn(async () => {
          throw notFound;
        }),
      },
      issues: {
        get: vi.fn(async () => ({
          data: {
            number: 12,
            title: '쿠폰 결제 적용',
            body: '## Acceptance Criteria\n- AC1: 만료된 쿠폰은 거부\n- AC2: 쿠폰은 1회만 사용\n- AC3: 할인 상한 적용',
            html_url: 'https://github.com/acme/shop/issues/12',
            state: 'open',
            labels: [],
          },
        })),
      },
    },
  } as unknown as Octokit;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qtg-wire-prev-'));
  scriptedPlanner();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** One CLI `plan` run, built the way src/adapters/cli.ts builds it. */
async function cliPlan(extra: string[] = [], outDir = dir) {
  const args = parseArgs([
    'plan',
    '--repo',
    'acme/shop',
    '--spec',
    '12',
    '--out-dir',
    outDir,
    '--language',
    'ko',
    ...extra,
  ]);
  const env = { GITHUB_TOKEN: 'ghs_test', ANTHROPIC_API_KEY: 'sk-test' };
  const req: ExecuteRequest = {
    input: cliInputReader(args, env),
    event: { name: 'workflow_dispatch' },
    owner: 'acme',
    repo: 'shop',
    octokit: fakeOctokit(),
    logger: silentLogger(),
    sink: { writeMarkdown: async () => {}, writeJson: async () => null },
    fullReportUrl: () => undefined,
    signal: new AbortController().signal,
    bypassGate: true,
    caseFileDir: outDir,
    defaultPreviousCases: join(outDir, 'qa-cases.json'),
  };
  const result = await execute(req);
  if (result.kind !== 'planned') throw new Error(`expected a plan run, got ${result.kind}`);
  return result.outcome;
}

const json = (d = dir) => JSON.parse(readFileSync(join(d, 'qa-cases.json'), 'utf8')) as CasesFile;

describe('SPEC v3 §5 file sink continues from the previous qa-cases.json', () => {
  it('SPEC v3 §5 a second CLI run in the same out-dir keeps every id and changes nothing', async () => {
    const first = await cliPlan();
    expect(first.status).toBe('ok');
    expect(first.sinks).toMatchObject([{ kind: 'file', created: 3, unchanged: 0 }]);
    const ids = json().cases.map((c) => c.case.caseId);
    expect(ids).toEqual(['shop-12-C01', 'shop-12-C02', 'shop-12-C03']);
    const files = ['qa-cases.json', 'qa-cases.csv', 'qa-cases.md'].map((f) =>
      readFileSync(join(dir, f), 'utf8'),
    );

    const second = await cliPlan();
    expect(second.sinks).toMatchObject([
      { kind: 'file', created: 0, updated: 0, unchanged: 3, obsoleted: 0 },
    ]);
    expect(second.cases.map((c) => c.caseId)).toEqual(ids);
    expect(
      ['qa-cases.json', 'qa-cases.csv', 'qa-cases.md'].map((f) => readFileSync(join(dir, f), 'utf8')),
    ).toEqual(files);
    // The planner was shown the earlier cases, so it could reuse their ids.
    const secondReq = vi.mocked(generatePlan).mock.calls[1]?.[0] as PlanRequest;
    expect(secondReq.existing.map((e) => e.caseId)).toEqual(ids);
  });

  it('SPEC v3 §5 --previous points at an earlier run elsewhere; a fresh out-dir starts from it', async () => {
    await cliPlan();
    const other = mkdtempSync(join(tmpdir(), 'qtg-wire-prev-other-'));
    try {
      const out = await cliPlan(['--previous', join(dir, 'qa-cases.json')], other);
      expect(out.sinks).toMatchObject([{ kind: 'file', created: 0, unchanged: 3 }]);
      expect(json(other).cases.map((c) => c.case.caseId)).toEqual([
        'shop-12-C01',
        'shop-12-C02',
        'shop-12-C03',
      ]);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('SPEC v3 §5 previousCasesFor', () => {
  const cfg = (previous = '') =>
    resolveConfig(
      (n) => ({ 'anthropic-api-key': 'sk', 'previous-cases': previous })[n] ?? '',
      parseRepoConfig(null),
    );

  it('SPEC v3 §5 the input wins; the default is used only when the file exists', () => {
    const logger = silentLogger();
    expect(cfg().previousCases).toBeNull();
    expect(cfg('  /x/prev.json ').previousCases).toBe('/x/prev.json');
    expect(
      previousCasesFor({ logger, defaultPreviousCases: join(dir, 'qa-cases.json') }, cfg('/x/prev.json')),
    ).toBe('/x/prev.json');
    expect(previousCasesFor({ logger, defaultPreviousCases: join(dir, 'qa-cases.json') }, cfg())).toBeNull();
    expect(previousCasesFor({ logger }, cfg())).toBeNull();
  });

  it('SPEC v3 §5 --previous maps to the previous-cases input', () => {
    const args = parseArgs(['plan', '--repo', 'a/b', '--spec', '1', '--previous', 'p.json']);
    expect(cliInputReader(args, {})('previous-cases')).toBe('p.json');
  });
});
