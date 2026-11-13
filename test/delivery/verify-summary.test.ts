import { describe, expect, it } from 'vitest';
import type { CodeStatus, QaCase } from '../../src/core/cases';
import { MAX_COMMENT_CHARS, STATE_RESERVE } from '../../src/delivery/render/markdown';
import {
  CODE_STATUS_ICON,
  MAX_ATTENTION_ITEMS,
  renderVerifyComment,
  renderVerifySummaryMarkdown,
  type SummaryCase,
  type VerifySummaryInput,
  verifyStrings,
} from '../../src/delivery/render/verify-summary';

const TICKETS = 'https://github.com/acme/shop/issues';

function qaCase(n: number, status: CodeStatus | null, overrides: Partial<SummaryCase> = {}): SummaryCase {
  const base: QaCase = {
    caseId: `SHOP-900-C${String(n).padStart(2, '0')}`,
    specRef: 'SHOP-900',
    lifecycle: 'active',
    title: `Wish list case ${n}`,
    acLabels: ['AC2'],
    technique: 'boundary',
    priority: 'P1',
    preconditions: ['Signed in'],
    testData: ['items = 100'],
    steps: ['Open the product', 'Tap the heart'],
    expected: ['"Wish list is full" shown', 'Count stays 100'],
    whyEasyToMiss: 'The spec gives the limit without saying whether it is included.',
    origin: 'spec',
  };
  return {
    ...base,
    url: `${TICKETS}/${100 + n}`,
    ...(status
      ? {
          codeStatus: {
            status,
            evidence: `WishlistService.add in src/wishlist.ts compares with >= 100. A second sentence that the top section leaves out.`,
            files: ['src/wishlist.ts', 'src/routes.ts'],
            sha: 'a1b2c3d4e5',
          },
        }
      : {}),
    ...overrides,
  };
}

function input(overrides: Partial<VerifySummaryInput> = {}): VerifySummaryInput {
  return {
    pr: {
      number: 42,
      title: 'Wish list',
      htmlUrl: 'https://github.com/acme/shop/pull/42',
      owner: 'acme',
      repo: 'shop',
    },
    spec: {
      ref: {
        source: 'jira',
        id: 'SHOP-900',
        raw: 'SHOP-900',
        url: 'https://acme.atlassian.net/browse/SHOP-900',
      },
      title: 'Wish list',
    },
    language: 'en',
    sha: 'a1b2c3d4e5f6',
    alignment: {
      status: 'misaligned',
      findings: [
        {
          requirement: 'AC1: an item can be added once',
          source: 'SHOP-900',
          status: 'covered',
          evidence: 'WishlistService.add checks for the item first.',
          files: ['src/wishlist.ts'],
        },
        {
          requirement: 'AC2: the list holds at most 100 items',
          source: 'SHOP-900',
          status: 'contradicts',
          evidence: 'The limit in the code is 200.',
          files: ['src/wishlist.ts'],
        },
      ],
    },
    cases: [
      qaCase(1, 'implemented', { priority: 'P0', title: 'Item added once' }),
      qaCase(2, 'contradicts', { priority: 'P0', title: '101st item rejected' }),
      qaCase(3, 'missing', { title: 'Removed item can be added again' }),
      qaCase(4, 'unknown', { priority: 'P0', title: 'Signed-out visitor sent to sign-in' }),
      qaCase(5, 'implemented', { priority: 'P2' }),
      qaCase(6, 'missing', {
        priority: 'P0',
        title: 'Two devices adding at once',
        origin: 'code',
        acLabels: [],
        whyEasyToMiss: 'WishlistService.add reads the count and inserts without a lock. More detail here.',
      }),
      qaCase(7, null, { lifecycle: 'obsolete', title: 'Old case' }),
    ],
    newCaseIds: ['SHOP-900-C06'],
    maxChecklist: 8,
    meta: {
      model: 'claude-opus-5-5',
      usage: { inputTokens: 9_000, outputTokens: 1_800, cacheReadTokens: 3_000, cacheWriteTokens: 0 },
      costUsd: 0.11,
      durationMs: 41_300,
      calls: 1,
      warnings: [],
    },
    ...overrides,
  };
}

const top = (body: string): string => body.slice(0, body.indexOf('<details>'));

describe('renderVerifyComment — PR summary of a verify run (SPEC v3 §2.2)', () => {
  it('SPEC v3 §2.2 shows the alignment badge, the spec with case counts, and the count per code status', () => {
    const body = renderVerifyComment(input());
    expect(body).toMatch(/^## 🧪 AI QA — <code>a1b2c3d<\/code> · ❌ \*\*Misaligned\*\*\n/);
    expect(body).toContain(
      '> Spec: [SHOP-900](https://acme.atlassian.net/browse/SHOP-900) Wish list · 6 cases (P0 4 · P1 1 · P2 1)',
    );
    expect(body).toContain(
      '**Code status**: ✅ Implemented 2 · ❌ Possibly missing 2 · ⛔ Contradicts the spec 1 · ❓ Cannot tell from code 1',
    );
    expect(body).toContain('> 1 obsolete case(s) are not shown');
    expect(body).not.toContain('Old case');
  });

  it('SPEC v3 §2.2 lists the cases the code misses or contradicts, contradictions first, each linked to its ticket', () => {
    const body = renderVerifyComment(input());
    expect(body).toContain('**Missing or contradicting (3)**');
    const lines = top(body)
      .split('\n')
      .filter((l) => /^- (⛔|❌) /.test(l));
    expect(lines).toEqual([
      `- ⛔ [SHOP-900-C02](${TICKETS}/102) **P0** 101st item rejected — WishlistService.add in src/wishlist.ts compares with &gt;= 100. <code>src/wishlist.ts</code> +1`,
      `- ❌ [SHOP-900-C06](${TICKETS}/106) **P0** Two devices adding at once — WishlistService.add in src/wishlist.ts compares with &gt;= 100. <code>src/wishlist.ts</code> +1`,
      `- ❌ [SHOP-900-C03](${TICKETS}/103) **P1** Removed item can be added again — WishlistService.add in src/wishlist.ts compares with &gt;= 100. <code>src/wishlist.ts</code> +1`,
    ]);
    // Only the first sentence of the evidence is in the top section.
    expect(top(body)).not.toContain('A second sentence');

    const clean = renderVerifyComment(
      input({ cases: [qaCase(1, 'implemented'), qaCase(2, 'unknown')], newCaseIds: [] }),
    );
    expect(clean).toContain('✅ **No case is missing or contradicted in this change**');
  });

  it('SPEC v3 §6 the P0 checklist shows at most max-scenarios cases, the ones that need attention first, with links', () => {
    const body = renderVerifyComment(input());
    const start = body.indexOf('**P0 checklist (4)**');
    expect(start).toBeGreaterThan(0);
    const lines = body.slice(start).split('\n').slice(1, 5);
    expect(lines).toEqual([
      `- [ ] [SHOP-900-C02](${TICKETS}/102) 101st item rejected → "Wish list is full" shown ⛔`,
      `- [ ] [SHOP-900-C06](${TICKETS}/106) Two devices adding at once → "Wish list is full" shown ❌`,
      `- [ ] [SHOP-900-C04](${TICKETS}/104) Signed-out visitor sent to sign-in → "Wish list is full" shown ❓`,
      `- [ ] [SHOP-900-C01](${TICKETS}/101) Item added once → "Wish list is full" shown ✅`,
    ]);

    const two = renderVerifyComment(input({ maxChecklist: 2 }));
    expect(two).toContain('**P0 checklist (2 of 4)**');
    expect(two.match(/^- \[ \] /gm)).toHaveLength(2);
    const none = renderVerifyComment(input({ cases: [qaCase(1, 'implemented')], newCaseIds: [] }));
    expect(none).toContain('_No P0 cases_');
  });

  it('SPEC v3 §2.2 names the cases this run added from the code, with what in the code creates the risk', () => {
    const body = renderVerifyComment(input());
    expect(body).toContain('**Added from the code (1)**');
    expect(body).toContain(
      `- [SHOP-900-C06](${TICKETS}/106) **P0** Two devices adding at once — WishlistService.add reads the count and inserts without a lock.`,
    );
    expect(renderVerifyComment(input({ newCaseIds: [] }))).not.toContain('Added from the code');
  });

  it('keeps the requirement findings and the full case list folded, sorted by what needs attention', () => {
    const body = renderVerifyComment(input());
    expect(body).toContain('<details><summary>Verdict per requirement (2)</summary>');
    expect(body).toContain(
      '| **AC2** the list holds at most 100 items | ⛔ contradicts | The limit in the code is 200. |',
    );
    expect(body).toContain('<details><summary>All cases (6)</summary>');
    const rows = body.split('\n').filter((l) => l.startsWith('| [SHOP-900-C'));
    expect(rows.map((r) => r.slice(3, 15))).toEqual([
      'SHOP-900-C02',
      'SHOP-900-C06',
      'SHOP-900-C03',
      'SHOP-900-C04',
      'SHOP-900-C01',
      'SHOP-900-C05',
    ]);
    expect(rows[0]).toBe(
      `| [SHOP-900-C02](${TICKETS}/102) | P0 | ⛔ Contradicts the spec | 101st item rejected |`,
    );
    expect(body).toMatch(
      /<sub><code>claude-opus-5-5<\/code> · .*12\.0K.*1\.8K.* · 1 LLM call\(s\) · ~\$0\.11 · 41s<\/sub>$/,
    );
  });

  it('a spec without cases says so instead of showing empty lists', () => {
    const body = renderVerifyComment(
      input({ cases: [], newCaseIds: [], alignment: { status: 'partial', findings: [] } }),
    );
    expect(body).toContain('ℹ️ This spec has no QA cases yet. Run the plan phase first.');
    expect(body).not.toContain('P0 checklist');
    expect(body).not.toContain('<details>');
  });

  it('cases that were not judged are counted apart and carry no status icon', () => {
    const body = renderVerifyComment(
      input({ cases: [qaCase(1, null, { priority: 'P0' }), qaCase(2, 'implemented')], newCaseIds: [] }),
    );
    expect(body).toContain('❓ Cannot tell from code 0 · Not judged 1');
    expect(body).toContain(
      `- [ ] [SHOP-900-C01](${TICKETS}/101) Wish list case 1 → "Wish list is full" shown\n`,
    );
    expect(body).toContain('| P0 | Not judged | Wish list case 1 |');
  });
});

describe('renderVerifyComment — a partly covered requirement (SPEC v3 §2.2)', () => {
  const partial = {
    requirement: 'AC1: an item can be added once',
    source: 'SHOP-900',
    status: 'partial' as const,
    evidence: 'The one-item check is in WishlistService.add; two devices at once are not handled.',
    files: ['src/wishlist.ts'],
  };

  it('SPEC v3 §2.2 shows it as partly covered, not as missing, under a "partially aligned" badge', () => {
    const body = renderVerifyComment(input({ alignment: { status: 'partial', findings: [partial] } }));
    expect(body).toContain('⚠️ **Partially aligned**');
    expect(body).toContain(
      '| **AC1** an item can be added once | ⚠️ partly covered | The one-item check is in WishlistService.add; two devices at once are not handled. |',
    );
    expect(body).not.toContain('❌ missing');
  });

  it.each([
    ['ko', '⚠️ 부분 충족'],
    ['ja', '⚠️ 一部充足'],
    ['zh-CN', '⚠️ 部分覆盖'],
  ] as const)('the label is written in %s', (language, label) => {
    expect(
      renderVerifyComment(input({ language, alignment: { status: 'partial', findings: [partial] } })),
    ).toContain(`| ${label} |`);
  });
});

describe('renderVerifyComment — after the first check (SPEC v3 §2.2)', () => {
  const earlier = (n: number, status: 'implemented' | 'contradicts') =>
    qaCase(n, status, {
      codeStatus: { status, evidence: 'Judged earlier.', files: ['src/routes.ts'], sha: '0ld5ha0ld5ha' },
    });

  it('SPEC v3 §2.2 says how many statuses are from this commit and how many were kept', () => {
    const body = renderVerifyComment(
      input({
        cases: [
          qaCase(1, 'implemented'),
          earlier(2, 'contradicts'),
          earlier(3, 'implemented'),
          qaCase(4, null),
        ],
      }),
    );
    expect(body).toContain(
      '\nJudged at this commit: 1 · kept from earlier checks: 2 (their code did not change)\n',
    );
    // Right under the counts it qualifies.
    expect(body.indexOf('Judged at this commit')).toBeGreaterThan(body.indexOf('**Code status**'));
    expect(body.indexOf('Judged at this commit')).toBeLessThan(body.indexOf('Missing or contradicting'));
    // A kept case still counts and is still listed with the status it keeps.
    expect(body).toContain('⛔ Contradicts the spec 1');
  });

  it('a first check, where every status is from this commit, has no such line', () => {
    // The fixture stamps cases with the short form of the commit the summary is for.
    expect(renderVerifyComment(input())).not.toContain('kept from earlier checks');
  });

  it.each([
    ['ko', '이번 커밋에서 판정 1건 · 이전 판정 유지 1건 (관련 코드 변경 없음)'],
    ['ja', 'このコミットで判定 1 件 · 以前の判定を維持 1 件 (関連コードの変更なし)'],
    ['zh-CN', '本次提交判定 1 条 · 沿用之前的判定 1 条 (相关代码未变更)'],
  ] as const)('the line is written in %s', (language, line) => {
    const body = renderVerifyComment(
      input({ language, cases: [qaCase(1, 'implemented'), earlier(2, 'implemented')] }),
    );
    expect(body).toContain(`\n${line}\n`);
  });
});

describe('renderVerifyComment — untrusted text and limits (DLV-03, DLV-06)', () => {
  it('DLV-06 sanitizes case text, evidence and spec titles, and links only plain https ticket URLs', () => {
    const body = renderVerifyComment(
      input({
        spec: {
          ref: { source: 'jira', id: 'SHOP-900', raw: 'SHOP-900', url: 'javascript:alert(1)' },
          title: '<img src=x> @everyone',
        },
        cases: [
          qaCase(1, 'missing', {
            priority: 'P0',
            title: '[click](https://evil.example) <script>x</script> 1~2 items | pipe',
            url: 'https://tickets.example/1) [x](https://evil.example',
            expected: ['see https://evil.example/a now'],
          }),
          qaCase(2, 'contradicts', { url: 'http://insecure.example/2', caseId: 'SHOP-900-C02<b>' }),
        ],
        newCaseIds: [],
      }),
    );
    expect(body).not.toContain('<script>');
    expect(body).not.toContain('<img');
    expect(body).not.toContain('](https://evil.example');
    expect(body).not.toContain('javascript:');
    expect(body).not.toContain('http://insecure.example');
    // A case whose link is not usable is shown by id only.
    expect(body).toContain('<code>SHOP-900-C01</code>');
    expect(body).toContain('<code>SHOP-900-C02b</code>');
    expect(body).toContain('1&#126;2 items &#124; pipe');
    expect(body).toContain('> Spec: SHOP-900 ');
  });

  it('DLV-03 a long sheet still fits the comment limit: the full case table gives way first', () => {
    const many = Array.from({ length: 300 }, (_, i) =>
      qaCase(i + 1, i % 3 === 0 ? 'missing' : 'implemented', {
        title: `Wish list case ${i + 1} ${'with a long title '.repeat(12)}`,
      }),
    );
    const body = renderVerifyComment(input({ cases: many, newCaseIds: [] }));
    expect(body.length).toBeLessThanOrEqual(MAX_COMMENT_CHARS - STATE_RESERVE);
    expect(body).toContain('**Missing or contradicting (100)**');
    expect(body.match(/^- ❌ /gm)).toHaveLength(MAX_ATTENTION_ITEMS);
    expect(body).toContain(`- … and ${100 - MAX_ATTENTION_ITEMS} more`);
    expect(body).toContain('<details><summary>Verdict per requirement (2)</summary>');
    expect(body).toMatch(/<sub>.*<\/sub>$/);
    // The job summary has no limit and shows every case.
    const full = renderVerifySummaryMarkdown(input({ cases: many, newCaseIds: [] }));
    expect(full.split('\n').filter((l) => l.startsWith('| [SHOP-900-C'))).toHaveLength(300);
  });

  it('shows run warnings and the dry-run note above the footer', () => {
    const body = renderVerifyComment(
      input({
        meta: {
          ...input().meta,
          dryRun: true,
          warnings: [{ code: 'cost_cap', message: '2 lower-priority file(s) were not judged.' }],
        },
      }),
    );
    expect(body).toContain('> ⚠️ 2 lower-priority file(s) were not judged.');
    expect(body).toContain('> dry run');
  });
});

describe('renderVerifyComment — four languages (ADR-0010)', () => {
  it.each(['en', 'ko', 'ja', 'zh-CN'] as const)('SPEC v3 §2.2 %s summary (snapshot)', async (language) => {
    const v = verifyStrings(language);
    const body = renderVerifyComment(input({ language }));
    for (const s of ['implemented', 'missing', 'contradicts', 'unknown'] as const) {
      expect(body, s).toContain(`${CODE_STATUS_ICON[s]} ${v.status[s]}`);
    }
    expect(body).toContain(`**${v.attention(3)}**`);
    expect(body).toContain(`**${v.p0Checklist(4, 4)}**`);
    expect(body).toContain(`**${v.fromCode(1)}**`);
    expect(body).toContain(`<summary>${v.allCases(6)}</summary>`);
    await expect(body).toMatchFileSnapshot(`../../fixtures/delivery/verify-summary.${language}.md.snap`);
  });

  it('every language has every string, and the Korean statuses are the ones the spec names', () => {
    const keys = (o: object): string[] => Object.keys(o).sort();
    for (const language of ['ko', 'ja', 'zh-CN'] as const) {
      expect(keys(verifyStrings(language)), language).toEqual(keys(verifyStrings('en')));
      expect(keys(verifyStrings(language).status)).toEqual(keys(verifyStrings('en').status));
    }
    expect(verifyStrings('ko').status).toEqual({
      implemented: '구현 확인됨',
      missing: '미구현 의심',
      contradicts: '기획과 상충',
      unknown: '코드로 판단 불가',
    });
  });
});
