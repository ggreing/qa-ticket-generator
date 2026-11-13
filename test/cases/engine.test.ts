import { describe, expect, it, vi } from 'vitest';
import {
  applyVerify,
  caseIdFor,
  caseNumber,
  compareCaseIds,
  lintCaseStyle,
  MAX_TITLE_LENGTH,
  mdSafe,
  OBSOLETE_LABEL,
  planSync,
  reconcileCases,
  renderCase,
  SPEC_GAP_PREFIX,
  STYLE_RULES,
  specKey,
  toolTextHash,
  toQaCase,
} from '../../src/cases';
import type { QaCase, SyncOp } from '../../src/core/cases';
import type { Language } from '../../src/core/contracts';
import { draft, planned, qaCase, ticket } from './helpers';

const QA_CASE_KEYS = new Set([
  'caseId',
  'specRef',
  'lifecycle',
  'title',
  'acLabels',
  'technique',
  'priority',
  'preconditions',
  'testData',
  'steps',
  'expected',
  'whyEasyToMiss',
  'origin',
  'codeStatus',
]);
const LANGUAGES: Language[] = ['ko', 'en', 'ja', 'zh-CN'];
const render = (c: QaCase) => renderCase(c, 'ko');

describe('SPEC v3 §4.1 ids and reconcile', () => {
  it.each([
    ['PROJ-123', 'PROJ-123'],
    ['proj-7', 'PROJ-7'],
    ['acme/shop#12', 'shop-12'],
    ['acme/shop.web#3', 'shop.web-3'],
    ['7c1e4b2a9d3f4e8a8b6c5d4e3f2a1b0c', '7c1e4b2a'],
    ['7C1E4B2A-9D3F-4E8A-8B6C-5D4E3F2A1B0C', '7c1e4b2a'],
    ['some spec / v2', 'some-spec-v2'],
    ['////', 'SPEC'],
  ])('SPEC v3 §4.1 specKey(%s) = %s', (ref, key) => {
    expect(specKey(ref)).toBe(key);
  });

  it('SPEC v3 §4.1 ids are zero-padded and sorted numerically', () => {
    expect(caseIdFor('P-1', 7)).toBe('P-1-C07');
    expect(caseIdFor('P-1', 123)).toBe('P-1-C123');
    expect(caseNumber('P-1', 'P-1-C09')).toBe(9);
    expect(caseNumber('P-1', 'P-2-C09')).toBeNull();
    expect(caseNumber('P-1', 'P-1-Cx')).toBeNull();
    expect(['P-1-C10', 'P-1-C2', 'P-1-C01'].sort(compareCaseIds)).toEqual(['P-1-C01', 'P-1-C2', 'P-1-C10']);
    expect(['B-C1', 'A-C2'].sort(compareCaseIds)).toEqual(['A-C2', 'B-C1']);
  });

  it('SPEC v3 §4.1 new ids ignore ids of another spec key and keep going past C99', () => {
    const existing = [ticket(qaCase('SHOP-101-C99', 'a')), ticket(qaCase('OLD-1-C500', 'b'))];
    const out = reconcileCases('SHOP-101', existing, [planned('new')]);
    expect(out.cases.map((c) => c.caseId)).toEqual(['SHOP-101-C100', 'OLD-1-C500', 'SHOP-101-C99']);
  });

  it('SPEC v3 §4.1 is deterministic and emits only tool-owned keys', () => {
    const existing = [
      ticket({
        ...qaCase('SHOP-101-C01', 'a'),
        ...({ execStatus: 'Fail', assignee: 'kim' } as object),
      } as QaCase),
      ticket(qaCase('SHOP-101-C02', 'b')),
    ];
    const plan = [planned('a', 'SHOP-101-C01'), planned('c'), planned('d', 'SHOP-101-C01')];
    const a = reconcileCases('SHOP-101', existing, plan);
    const b = reconcileCases('SHOP-101', structuredClone(existing), structuredClone(plan));
    expect(b).toStrictEqual(a);
    for (const c of a.cases) for (const k of Object.keys(c)) expect(QA_CASE_KEYS.has(k), k).toBe(true);
    expect(JSON.stringify(a)).not.toMatch(/execStatus|assignee|kim/);
  });

  it('SPEC v3 §4.1 normalises model output: trims, drops empty items, dedupes AC labels, defaults bad enums', () => {
    const c = toQaCase(
      {
        ...draft('  제목  '),
        acLabels: ['AC1', 'AC1', ' '],
        steps: [' 진입 ', ''],
        technique: 'nonsense' as never,
        priority: 'P9' as never,
        origin: 'x' as never,
      },
      'X-C01',
      'X',
      'active',
      undefined,
    );
    expect(c).toMatchObject({
      title: '제목',
      acLabels: ['AC1'],
      steps: ['진입'],
      technique: 'happy_path',
      priority: 'P1',
      origin: 'spec',
    });
    expect('codeStatus' in c).toBe(false);
  });
});

describe('SPEC v3 §4.2–§4.5 planSync invariants', () => {
  const base = [qaCase('SHOP-101-C01', 'a'), qaCase('SHOP-101-C02', 'b'), qaCase('SHOP-101-C03', 'c')];

  it('SPEC v3 §4.2 ops never carry human-owned fields in the case they write', () => {
    const existing = [
      ticket(base[0] as QaCase, { human: { execStatus: 'Fail', assignee: 'kim' } }),
      ticket(base[1] as QaCase, { edited: true, human: { execStatus: 'Blocked', assignee: 'lee' } }),
    ];
    const next = [
      { ...(base[0] as QaCase), expected: ['바뀐 결과'] },
      { ...(base[1] as QaCase), steps: ['바뀜'] },
      base[2] as QaCase,
    ];
    const ops = planSync(existing, next, render);
    expect(ops.map((o) => o.op)).toEqual(['update', 'suggest', 'create']);
    for (const o of ops) {
      if (!('case' in o)) continue;
      for (const k of Object.keys(o.case)) expect(QA_CASE_KEYS.has(k), k).toBe(true);
      const r = render(o.case);
      expect(JSON.stringify(r)).not.toMatch(/Fail|Blocked|kim|lee/);
    }
  });

  it('SPEC v3 §4.2 does not mutate its inputs and renders each matched case at most once', () => {
    const existing = base.map((c) => ticket(c));
    const next = base.map((c) => ({ ...c, title: `${c.title}!` }));
    const before = structuredClone({ existing, next });
    const spy = vi.fn(render);
    planSync(existing, next, spy);
    expect({ existing, next }).toStrictEqual(before);
    expect(spy).toHaveBeenCalledTimes(3);
    planSync([], next, spy); // creates do not need a render
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('SPEC v3 §4.2 a second run over what the first wrote is all unchanged (no duplicates)', () => {
    const first = planSync([], base, render) as Extract<SyncOp, { op: 'create' }>[];
    const written = first.map((o) => ticket(o.case));
    expect(planSync(written, base, render).map((o) => o.op)).toEqual(['unchanged', 'unchanged', 'unchanged']);
  });
});

describe('SPEC v3 §3.1 renderCase', () => {
  const c = qaCase('SHOP-101-C01', '만료 1초 지난 쿠폰 적용 시 거부', { priority: 'P0' });

  it('SPEC v3 §3.1 hash changes with every tool-owned field and with the language', () => {
    const h = renderCase(c, 'ko').hash;
    const variants: Partial<QaCase>[] = [
      { title: '다른 제목' },
      { priority: 'P2' },
      { technique: 'failure' },
      { acLabels: ['AC9'] },
      { preconditions: ['다름'] },
      { testData: ['다름'] },
      { steps: ['다름'] },
      { expected: ['다름'] },
      { whyEasyToMiss: '다름' },
      { lifecycle: 'obsolete' },
      { codeStatus: { status: 'implemented', evidence: 'x', files: [], sha: 'abc' } },
    ];
    for (const v of variants) expect(renderCase({ ...c, ...v }, 'ko').hash, JSON.stringify(v)).not.toBe(h);
    expect(renderCase(c, 'en').hash).not.toBe(h);
    expect(renderCase(structuredClone(c), 'ko').hash).toBe(h);
    expect(toolTextHash('a\r\nb', 'c\r\n')).toBe(toolTextHash('a\nb', 'c\n'));
  });

  it.each(LANGUAGES)('SPEC v3 §4.4 obsolete title prefix (%s)', (lang) => {
    expect(
      renderCase({ ...c, lifecycle: 'obsolete' }, lang).title.startsWith(`[${OBSOLETE_LABEL[lang]}][P0]`),
    ).toBe(true);
  });

  it('SPEC v3 §3.1 long titles are cut to the sink limit', () => {
    const t = renderCase({ ...c, title: '가'.repeat(400) }, 'ko').title;
    expect(t.length).toBe(MAX_TITLE_LENGTH);
    expect(t.endsWith('…')).toBe(true);
  });

  it('SPEC v3 §3.1 empty sections are left out; code status renders without sha, evidence or files', () => {
    const r = renderCase(
      {
        ...c,
        preconditions: [],
        testData: [],
        whyEasyToMiss: ' ',
        acLabels: [],
        codeStatus: { status: 'unknown', evidence: '', files: [], sha: '' },
      },
      'ko',
    );
    expect(r.markdown).not.toMatch(/전제 조건|테스트 데이터|놓치기 쉬운 이유|관련 AC/);
    expect(r.markdown).toMatch(/### 코드 상태\n\n\*\*코드로 판단 불가\*\*$/);
    expect(r.fields).toMatchObject({ code_status: 'unknown', code_sha: '', ac: '' });
  });

  it('SPEC v3 §3.1 mdSafe escapes every Markdown-significant character', () => {
    expect(mdSafe('a*b_c`d[e]f<g>h#i|j~k&l\\m')).toBe('a\\*b\\_c\\`d\\[e\\]f\\<g\\>h\\#i\\|j\\~k\\&l\\\\m');
    expect(mdSafe('1) 시작')).toBe('1\\) 시작');
    expect(mdSafe('+ 시작')).toBe('\\+ 시작');
    expect(mdSafe('===')).toBe('\\===');
    expect(mdSafe('\u200b보이지\u202e않는')).toBe('보이지않는');
  });
});

describe('SPEC v3 §3.1 STYLE_RULES', () => {
  it('SPEC v3 §3.1 every rule is global, scoped and has a prompt hint; languages share the common rules', () => {
    const common = [
      'emoji',
      'dash-explanation',
      'title-label',
      'title-colon',
      'title-too-long',
      'why-multi-sentence',
    ];
    for (const lang of LANGUAGES) {
      const rules = STYLE_RULES[lang];
      for (const r of rules) {
        expect(r.pattern.flags, `${lang}/${r.rule}`).toContain('g');
        expect(r.hint.length, `${lang}/${r.rule}`).toBeGreaterThan(10);
        expect(r.fields.length, `${lang}/${r.rule}`).toBeGreaterThan(0);
      }
      for (const id of common)
        expect(
          rules.some((r) => r.rule === id),
          `${lang}/${id}`,
        ).toBe(true);
    }
  });

  it.each(LANGUAGES)('SPEC v3 §3.1 the spec-gap line is allowed (%s)', (lang) => {
    const c = draft('Title', { expected: [`${SPEC_GAP_PREFIX[lang]}: X`] });
    expect(lintCaseStyle(c, lang).filter((v) => v.text.includes(SPEC_GAP_PREFIX[lang]))).toEqual([]);
  });

  it('SPEC v3 §3.1 an empty case yields no violations and lint is repeatable', () => {
    const empty = {
      ...draft(''),
      preconditions: [],
      testData: [],
      steps: [],
      expected: [],
      whyEasyToMiss: '',
    };
    expect(lintCaseStyle(empty, 'ko')).toEqual([]);
    const bad = draft('올바르게 거부되는지 확인하는 테스트');
    expect(lintCaseStyle(bad, 'ko')).toEqual(lintCaseStyle(bad, 'ko'));
  });
});

describe('SPEC v3 §2.2 applyVerify invariants', () => {
  it('SPEC v3 §2.2 is pure, deterministic and emits only tool-owned keys', () => {
    const cases = [
      { ...qaCase('SHOP-101-C01', 'a'), ...({ execStatus: 'Pass' } as object) } as QaCase,
      qaCase('SHOP-101-C02', 'b', { origin: 'code', lifecycle: 'obsolete' }),
    ];
    const result = {
      statuses: [{ caseId: 'SHOP-101-C01', status: 'implemented' as const, evidence: 'e', files: ['f.ts'] }],
      newCases: [draft('b', { origin: 'code' }), draft('c')],
    };
    const before = structuredClone({ cases, result });
    const a = applyVerify(cases, result, 'sha1', 'SHOP-101');
    expect({ cases, result }).toStrictEqual(before);
    expect(applyVerify(structuredClone(cases), structuredClone(result), 'sha1', 'SHOP-101')).toStrictEqual(a);
    for (const c of a.cases) for (const k of Object.keys(c)) expect(QA_CASE_KEYS.has(k), k).toBe(true);
    expect(a.cases.map((c) => [c.caseId, c.lifecycle])).toEqual([
      ['SHOP-101-C01', 'active'],
      ['SHOP-101-C02', 'active'],
      ['SHOP-101-C03', 'active'],
    ]);
  });
});
