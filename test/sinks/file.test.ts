import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planSync, reconcileCases, renderCase } from '../../src/cases';
import type { CaseSetSummary, CaseSink, QaCase, SyncOp } from '../../src/core/cases';
import type { Language, PrdRef } from '../../src/core/contracts';
import {
  type CasesFile,
  CSV_COLUMNS,
  createFileCaseSink,
  csvCell,
  FILE_NAMES,
  orderCases,
  renderCsv,
  renderMarkdownFile,
} from '../../src/sinks/file';
import { planned, qaCase } from '../cases/helpers';
import { silentLogger } from '../helpers/fakes';

const SPEC: PrdRef = {
  source: 'jira',
  id: 'SHOP-101',
  url: 'https://acme.atlassian.net/browse/SHOP-101',
  raw: 'SHOP-101',
};
const signal = new AbortController().signal;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qtg-file-sink-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function summary(cases: QaCase[], language: Language = 'ko'): CaseSetSummary {
  return {
    specRef: SPEC,
    specTitle: '쿠폰 | 결제',
    language,
    cases: cases.map((c) => ({
      caseId: c.caseId,
      title: c.title,
      priority: c.priority,
      lifecycle: c.lifecycle,
    })),
    counts: { total: cases.length, byPriority: { P0: 0, P1: 0, P2: 0 }, obsolete: 0 },
    meta: { model: 'm', costUsd: 0, mode: 'plan' },
  };
}

/** What the plan pipeline does with one sink: list → planSync → apply → publishSummary. */
async function runOnce(sink: CaseSink, next: QaCase[], language: Language = 'ko'): Promise<SyncOp[]> {
  const existing = await sink.list(SPEC, signal);
  const render = (c: QaCase) => renderCase(c, language);
  const ops = planSync(existing, next, render);
  for (const op of ops) {
    if (op.op === 'create') await sink.create(SPEC, op.case, render(op.case), signal);
    if (op.op === 'update') await sink.update(op.ticket, op.case, render(op.case), signal);
    if (op.op === 'suggest') await sink.suggest(op.ticket, op.case, render(op.case), signal);
    if (op.op === 'obsolete') await sink.markObsolete(op.ticket, signal);
  }
  await sink.publishSummary(SPEC, summary(next, language), signal);
  return ops;
}

const read = (name: string) => readFileSync(join(dir, name), 'utf8');
const sink = (previous: string | null, language: Language = 'ko') =>
  createFileCaseSink({ dir, previous }, { logger: silentLogger(), language });

const cases = [
  qaCase('SHOP-101-C01', '만료 1초 지난 쿠폰 적용 시 거부', { priority: 'P0', acLabels: ['AC3'] }),
  qaCase('SHOP-101-C02', '같은 쿠폰 두 번째 적용 시 거부', { technique: 'idempotency' }),
  qaCase('SHOP-101-C03', '프로모션 장바구니 쿠폰 적용 시 거부', {
    priority: 'P2',
    acLabels: [],
    origin: 'code',
    codeStatus: { status: 'contradicts', evidence: 'x', files: ['a.ts'], sha: 'abc1234' },
  }),
];

describe('SPEC v3 §5 file sink', () => {
  it('SPEC v3 §5 writes qa-cases.json, .csv and .md on publishSummary', async () => {
    const s = sink(null);
    expect(s.kind).toBe('file');
    expect(s.isConfigured()).toBe(true);
    const ops = await runOnce(s, cases);
    expect(ops.map((o) => o.op)).toEqual(['create', 'create', 'create']);

    const json = JSON.parse(read(FILE_NAMES.json)) as CasesFile;
    expect(json).toMatchObject({ version: 1, spec: SPEC, specTitle: '쿠폰 | 결제', language: 'ko' });
    expect(json.cases.map((x) => x.case.caseId)).toEqual(['SHOP-101-C01', 'SHOP-101-C02', 'SHOP-101-C03']);
    expect(json.cases[0]?.hash).toBe(renderCase(cases[0] as QaCase, 'ko').hash);

    const md = read(FILE_NAMES.markdown);
    expect(md).toContain('# QA 케이스: 쿠폰 \\| 결제 (SHOP-101)');
    expect(md).toContain('전체 3건 · P0 1 · P1 1 · P2 1');
    expect(md).toMatch(/## P0\n\n\| ID \| 제목 \| 기법 \| AC \| 코드 상태 \|\n\| --- /);
    expect(md).toContain(
      '| SHOP-101-C03 | 프로모션 장바구니 쿠폰 적용 시 거부 | 경계값 | 코드 출처 | 기획과 상충 |',
    );
    expect(md).toContain('### SHOP-101-C01 \\[P0\\]\\[경계값\\] 만료 1초 지난 쿠폰 적용 시 거부');
    expect(md).toContain('#### 기대 결과');
    expect(md).not.toMatch(/^### 기대 결과/m);

    const csv = read(FILE_NAMES.csv);
    expect(csv.startsWith('\ufeff')).toBe(true);
    expect(csv.slice(1).split('\r\n')[0]).toBe(CSV_COLUMNS.join(','));
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('SPEC v3 §5 a second run from the previous json is all unchanged and writes the same files', async () => {
    await runOnce(sink(null), cases);
    const first = [read(FILE_NAMES.json), read(FILE_NAMES.csv), read(FILE_NAMES.markdown)];
    const previous = join(dir, 'previous.json');
    writeFileSync(previous, first[0] as string);
    const ops = await runOnce(sink(previous), cases);
    expect(ops.map((o) => o.op)).toEqual(['unchanged', 'unchanged', 'unchanged']);
    expect([read(FILE_NAMES.json), read(FILE_NAMES.csv), read(FILE_NAMES.markdown)]).toEqual(first);
  });

  it('SPEC v3 §4.4 a case the spec drops is kept as obsolete in every file', async () => {
    await runOnce(sink(null), cases);
    const previous = join(dir, 'previous.json');
    writeFileSync(previous, read(FILE_NAMES.json));
    const s = sink(previous);
    const existing = await s.list(SPEC, signal);
    const { cases: next } = reconcileCases(SPEC.id, existing, [
      planned('만료 1초 지난 쿠폰 적용 시 거부', 'SHOP-101-C01', { priority: 'P0', acLabels: ['AC3'] }),
      planned('같은 쿠폰 두 번째 적용 시 거부', 'SHOP-101-C02', { technique: 'idempotency' }),
    ]);
    const ops = await runOnce(s, next);
    expect(ops.map((o) => `${o.op}`)).toEqual(['unchanged', 'unchanged', 'obsolete']);
    const json = JSON.parse(read(FILE_NAMES.json)) as CasesFile;
    expect(json.cases.find((x) => x.case.caseId === 'SHOP-101-C03')?.case.lifecycle).toBe('obsolete');
    expect(read(FILE_NAMES.markdown)).toContain('## 해당 없음');
    expect(read(FILE_NAMES.markdown)).toContain('\\[해당 없음\\]\\[P2\\]');
    expect(read(FILE_NAMES.csv)).toMatch(/\r\nSHOP-101-C03,[\s\S]*,obsolete,기획과 상충\r\n$/);

    // Third run: still obsolete, nothing to do.
    writeFileSync(previous, read(FILE_NAMES.json));
    const s3 = sink(previous);
    const again = reconcileCases(SPEC.id, await s3.list(SPEC, signal), [
      planned('만료 1초 지난 쿠폰 적용 시 거부', 'SHOP-101-C01', { priority: 'P0', acLabels: ['AC3'] }),
      planned('같은 쿠폰 두 번째 적용 시 거부', 'SHOP-101-C02', { technique: 'idempotency' }),
    ]);
    expect((await runOnce(s3, again.cases)).map((o) => o.op)).toEqual([
      'unchanged',
      'unchanged',
      'unchanged',
    ]);
  });

  it('SPEC v3 §5 list() tolerates a missing, corrupt or foreign previous file', async () => {
    expect(await sink(null).list(SPEC, signal)).toEqual([]);
    expect(await sink(join(dir, 'nope.json')).list(SPEC, signal)).toEqual([]);
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{not json');
    expect(await sink(bad).list(SPEC, signal)).toEqual([]);
    writeFileSync(bad, JSON.stringify({ version: 2, cases: [] }));
    expect(await sink(bad).list(SPEC, signal)).toEqual([]);

    await runOnce(sink(null), cases);
    const other = { ...SPEC, id: 'OTHER-1', raw: 'OTHER-1' };
    expect(await sink(join(dir, FILE_NAMES.json)).list(other, signal)).toEqual([]);
  });

  it('SPEC v3 §5 list() returns tickets with equal hashes and no human fields, dropping malformed entries', async () => {
    const file = {
      version: 1,
      spec: SPEC,
      specTitle: 't',
      language: 'ko',
      cases: [
        { case: { ...cases[0], execStatus: 'Fail' }, hash: 'h1' },
        { case: { title: 'no id' }, hash: 'h2' },
        { case: cases[1], hash: 42 },
      ],
    };
    const p = join(dir, 'prev.json');
    writeFileSync(p, `\ufeff${JSON.stringify(file)}`);
    const tickets = await sink(p).list(SPEC, signal);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({
      caseId: 'SHOP-101-C01',
      ticketRef: 'SHOP-101-C01',
      writtenHash: 'h1',
      currentHash: 'h1',
      human: {},
    });
    expect(JSON.stringify(tickets)).not.toContain('execStatus');
  });

  it('SPEC v3 §5 suggest and update both rewrite the entry (files have no human edits)', async () => {
    const s = sink(null);
    const c = cases[0] as QaCase;
    await s.create(SPEC, c, renderCase(c, 'ko'), signal);
    const changed = { ...c, expected: ['다른 결과'] };
    const t = {
      caseId: c.caseId,
      ticketRef: c.caseId,
      url: '',
      lastWritten: c,
      writtenHash: null,
      currentHash: 'x',
      human: {},
    };
    await s.suggest(t, changed, renderCase(changed, 'ko'), signal);
    await s.markObsolete({ ...t, caseId: 'UNKNOWN', lastWritten: null }, signal); // nothing to mark
    await s.publishSummary(SPEC, summary([changed]), signal);
    const json = JSON.parse(read(FILE_NAMES.json)) as CasesFile;
    expect(json.cases.map((x) => x.case.expected)).toEqual([['다른 결과']]);
  });
});

describe('SPEC v3 §5 qa-cases.md', () => {
  it.each([
    ['en', '# QA cases: ', '1 cases · P0 0 · P1 1 · P2 0', '## Case details'],
    ['ja', '# QAケース: ', '全1件 · P0 0 · P1 1 · P2 0', '## ケース詳細'],
    ['zh-CN', '# QA用例: ', '共1条 · P0 0 · P1 1 · P2 0', '## 用例详情'],
    ['ko', '# QA 케이스: ', '전체 1건 · P0 0 · P1 1 · P2 0', '## 케이스 상세'],
  ] as const)('SPEC v3 §5 labels in %s', (language, heading, totals, details) => {
    const c = qaCase('SHOP-101-C01', 't');
    const md = renderMarkdownFile({
      spec: SPEC,
      specTitle: 'Spec',
      language,
      cases: [{ case: c, hash: 'h' }],
    });
    expect(md).toContain(`${heading}Spec (SHOP-101)`);
    expect(md).toContain(totals);
    expect(md).toContain(details);
  });

  it('SPEC v3 §5 an empty set still has a heading and totals', () => {
    const md = renderMarkdownFile({ spec: SPEC, specTitle: 'Spec', language: 'en', cases: [] });
    expect(md).toBe('# QA cases: Spec (SHOP-101)\n\n0 cases · P0 0 · P1 0 · P2 0\n');
  });
});

describe('SPEC v3 §5 CSV', () => {
  it('SPEC v3 §5 quotes per RFC 4180 and neutralises spreadsheet formulas', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\r\nline2')).toBe('"line1\nline2"');
    expect(csvCell('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('-x')).toBe("'-x");
    expect(csvCell('-1')).toBe('-1');
  });

  it('SPEC v3 §5 rows: active by priority then id, obsolete last; TestRail columns filled', () => {
    const rows = [
      qaCase('SHOP-101-C10', 'p1 later', { priority: 'P1' }),
      qaCase('SHOP-101-C02', 'obsolete p0', { priority: 'P0', lifecycle: 'obsolete' }),
      qaCase('SHOP-101-C09', 'p0', { priority: 'P0', steps: ['1. 진입', '- 적용'] }),
      qaCase('SHOP-101-C03', 'p1', { priority: 'P1' }),
    ];
    expect(orderCases(rows).map((c) => c.caseId)).toEqual([
      'SHOP-101-C09',
      'SHOP-101-C03',
      'SHOP-101-C10',
      'SHOP-101-C02',
    ]);
    const lines = renderCsv(rows, 'en').slice(1).split('\r\n');
    expect(lines[1]).toBe(
      'SHOP-101-C09,p0,AC1,P0,Boundary,로그인 상태,쿠폰 EXP1 / 만료 2026-11-13 23:59:59,"1. 진입\n2. 적용","""만료된 쿠폰입니다"" 토스트 노출\n결제 금액 변화 없음",SHOP-101,기획서에 만료 시각 포함 여부 정의 없음,active,',
    );
  });
});
