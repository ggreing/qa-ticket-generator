import { describe, expect, it } from 'vitest';
import type { Language, QaReport } from '../../src/core/contracts';
import { strings } from '../../src/delivery/render/i18n';
import {
  formatTokens,
  MAX_COMMENT_CHARS,
  refLabel,
  renderPrComment,
  renderSummaryMarkdown,
  STATE_RESERVE,
} from '../../src/delivery/render/markdown';
import { expectedSummary, splitRequirement, ticketTag } from '../../src/delivery/render/ticket';
import { fakeReport } from '../helpers/fakes';
import { finalReport, richReport } from './support';

const LANGUAGES: Language[] = ['en', 'ko', 'ja', 'zh-CN'];
const LIMIT = MAX_COMMENT_CHARS - STATE_RESERVE;
type Scenario = QaReport['scenarios'][number];
type Finding = QaReport['prdAlignment']['findings'][number];
const scenario = (overrides: Partial<Scenario>): Scenario => ({
  ...(fakeReport().scenarios[0] as Scenario),
  ...overrides,
});
const finding = (overrides: Partial<Finding>): Finding => ({
  ...(fakeReport().prdAlignment.findings[0] as Finding),
  ...overrides,
});
/** Lines before the first folded block: what a reviewer sees without unfolding anything. */
const topOf = (body: string): string[] => body.slice(0, body.indexOf('<details>')).trimEnd().split('\n');

describe('renderPrComment — QA ticket layout (SPEC §4.6, M3.5)', () => {
  it.each(LANGUAGES)('SPEC §4.6 renders the full comment in %s (snapshot)', async (language) => {
    const body = renderPrComment(finalReport({ language }));
    // `.md.snap` rather than `.md`, so the repo formatter leaves the exact rendered bytes alone.
    await expect(body).toMatchFileSnapshot(`../../fixtures/delivery/pr-comment.${language}.md.snap`);
  });

  it('SPEC §4.6 top section: verdict header, then action needed, then the P0 checklist', () => {
    const body = renderPrComment(finalReport());
    expect(topOf(body)).toEqual([
      '## 🧪 AI QA — <code>a1b2c3d</code> · ⚠️ **Partially aligned**',
      '',
      '> Linked: [PROJ-123](https://acme.atlassian.net/browse/PROJ-123) (Jira), [acme/shop#45](https://github.com/acme/shop/issues/45) (GitHub)',
      '',
      '**Action needed (1)**',
      '- ❌ **AC3** expired coupons are rejected — No expiry comparison in coupon.ts <code>src/coupon.ts</code>',
      '',
      '**P0 checklist (1)**',
      '- [ ] **TC-01** Apply a coupon one second before expiry → the discount is applied',
    ]);
    // The renderer leaves the marker and the state block to the comment store.
    expect(body).not.toContain('qa-ticket-generator:report');
    expect(body).not.toContain('qtg-state');
  });

  it('SPEC §4.6 ticket card: title with priority and AC tag, preconditions, data, numbered steps, expected, related', () => {
    const report = richReport();
    (report.scenarios[0] as Scenario).when = ['open the cart', 'apply coupon EXP1'];
    const body = renderPrComment(finalReport({ report }));
    const card = body.slice(body.indexOf('<details><summary><b>TC-01'), body.indexOf('</details>') + 10);
    expect(card.split('\n')).toEqual([
      '<details><summary><b>TC-01 Apply a coupon one second before expiry</b> [P0 · AC3]</summary>',
      '',
      '- **Preconditions**: a coupon that expires in 1 second',
      '- **Data**: <code>coupon.expiresAt = now + 1s</code> · <code>order.subtotal = 30000</code>',
      '- **Steps**:',
      '  1. open the cart',
      '  2. apply coupon EXP1',
      '- **Expected**: the discount is applied',
      '- **Related**: AC3: expired coupons are rejected · <code>src/coupon.ts</code>',
      '- **Why**: Boundary of the expiry rule.',
      '',
      '</details>',
    ]);
  });

  it('SPEC §4.6 P1 and P2 cards share one fold, after the P0 cards', () => {
    const body = renderPrComment(finalReport());
    const fold = body.indexOf('<details><summary>P1 · P2 tickets (2)</summary>');
    expect(fold).toBeGreaterThan(body.indexOf('<details><summary><b>TC-01'));
    expect(body.indexOf('<details><summary><b>TC-02')).toBeGreaterThan(fold);
    expect(body.indexOf('<details><summary><b>TC-03')).toBeGreaterThan(fold);
    expect(body).toContain(
      '<details><summary><b>TC-02 Apply the same coupon twice in parallel</b> [P1 · AC1]</summary>',
    );
    expect(body).toContain(
      '<details><summary><b>TC-03 Checkout without a coupon still works</b> [P2]</summary>',
    );
    // Lists with several entries nest; confidence is shown only when it is not high.
    expect(body).toContain(
      '- **Preconditions**:\n  - a coupon that was never used\n  - two checkout tabs for the same cart',
    );
    expect(body).toContain(
      '- **Expected**:\n  - exactly one request succeeds\n  - the other one gets a <code>COUPON&#95;ALREADY&#95;USED</code> error',
    );
    expect(body).toContain('- **Confidence**: medium');
    expect(body.match(/- \*\*Confidence\*\*/g)).toHaveLength(2);
    expect(body.match(/<details>/g)).toHaveLength(body.match(/<\/details>/g)?.length ?? -1);
  });

  it('SPEC §4.6 the verdict per requirement, risks, assumptions and footer follow the tickets', () => {
    const body = renderPrComment(finalReport());
    const order = [
      '<details><summary>P1 · P2 tickets (2)</summary>',
      '<details><summary>Verdict per requirement (2)</summary>',
      'Adds coupon application to checkout.',
      '| Requirement | Status | Evidence |',
      '| AC3: expired coupons are rejected | ❌ missing | No expiry comparison in coupon.ts <code>src/coupon.ts</code> |',
      '### Risks',
      '- 🔴 **Missing expiry check** — AC3 not implemented <code>src/coupon.ts</code>',
      '### Assumptions',
      '<sub>',
    ].map((text) => body.indexOf(text));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(body.split('\n').at(-1)).toMatch(/^<sub>.*<\/sub>$/);
  });

  it('SPEC §4.6 lists contradicted and missing requirements as action items, unclear ones apart', () => {
    const report = richReport({
      prdAlignment: {
        status: 'misaligned',
        findings: [
          finding({
            requirement: 'AC1: only admins export',
            status: 'contradicts',
            evidence: 'managers pass',
            files: ['a.py', 'b.py'],
          }),
          finding({ requirement: 'AC2: audit log', status: 'covered' }),
          finding({ requirement: 'Exports are rate limited', status: 'missing', evidence: '', files: [] }),
          finding({
            requirement: 'AC4 - retention is 30 days',
            status: 'unclear',
            evidence: 'not in this diff',
            files: [],
          }),
        ],
      },
    });
    const top = topOf(renderPrComment(finalReport({ report }))).join('\n');
    expect(top).toContain('· ❌ **Misaligned**');
    expect(top).toContain(
      '**Action needed (2)**\n- ⛔ **AC1** only admins export — managers pass <code>a.py</code> +1\n- ❌ Exports are rate limited',
    );
    expect(top).toContain('**Needs a check (1)**\n- ❓ **AC4** retention is 30 days — not in this diff');
    expect(top).not.toContain('audit log');
  });

  it('SPEC §4.6 an aligned report says every requirement is covered', () => {
    const report = richReport({
      prdAlignment: {
        status: 'aligned',
        findings: [finding({ status: 'covered' }), finding({ status: 'covered' })],
      },
    });
    const top = topOf(renderPrComment(finalReport({ report })));
    expect(top[0]).toContain('· ✅ **Aligned**');
    expect(top).toContain('✅ **All 2 requirement(s) are covered**');
    expect(top.join('\n')).not.toContain('Action needed (');
  });

  it('SPEC §4.6 the top section fits one screen: long lists are capped and long text is shortened', () => {
    const findings = Array.from({ length: 30 }, (_, i) =>
      finding({
        requirement: `AC${i + 1}: ${'r'.repeat(300)}`,
        status: 'missing',
        evidence: 'e'.repeat(500),
      }),
    );
    const scenarios = Array.from({ length: 30 }, (_, i) =>
      scenario({ id: `TC-${i + 1}`, title: `p0 number ${i + 1}`, priority: 'P0', then: ['t'.repeat(400)] }),
    );
    const top = topOf(
      renderPrComment(
        finalReport({ report: richReport({ scenarios, prdAlignment: { status: 'partial', findings } }) }),
      ),
    );
    expect(top.length).toBeLessThanOrEqual(30);
    expect(top).toContain('**Action needed (30)**');
    expect(top).toContain('- … and 22 more');
    expect(top).toContain('**P0 checklist (30)**');
    expect(top).toContain('- … and 20 more');
    for (const line of top) expect(line.length).toBeLessThan(420);
  });

  it('SPEC §4.6 says so when there is no P0 scenario, and renders nothing for an empty scenario list', () => {
    const onlyP2 = renderPrComment(
      finalReport({ report: richReport({ scenarios: [scenario({ id: 'TC-01', priority: 'P2' })] }) }),
    );
    expect(topOf(onlyP2)).toContain('_No P0 scenarios_');
    expect(onlyP2).toContain('<details><summary>P1 · P2 tickets (1)</summary>');
    const none = renderPrComment(finalReport({ report: richReport({ scenarios: [] }) }));
    expect(none).not.toContain('P0');
    expect(none).not.toContain('tickets (');
  });

  it('ticket helpers: requirement labels, tags and the one-line expected result', () => {
    expect(splitRequirement('AC2: expired coupons are rejected')).toEqual({
      label: 'AC2',
      text: 'expired coupons are rejected',
    });
    expect(splitRequirement('REQ-12 - must log')).toEqual({ label: 'REQ-12', text: 'must log' });
    expect(splitRequirement('FR 1.2) exports')).toEqual({ label: 'FR1.2', text: 'exports' });
    expect(splitRequirement('Expired coupons are rejected')).toEqual({
      label: null,
      text: 'Expired coupons are rejected',
    });
    expect(
      ticketTag(
        scenario({ priority: 'P1', relatedRequirements: ['AC2: a', 'AC4: b', 'AC2: again', 'free text'] }),
      ),
    ).toBe('P1 · AC2, AC4');
    expect(ticketTag(scenario({ priority: 'P2', relatedRequirements: [] }))).toBe('P2');
    expect(expectedSummary(scenario({ then: ['', `  ${'x'.repeat(150)}`] }))).toHaveLength(100);
    expect(expectedSummary(scenario({ then: [] }))).toBe('');
  });

  it('OBS-02 shows model, effort, mode, tokens, cost, duration, skipped files and redactions in the footer', () => {
    const body = renderPrComment(
      finalReport(
        {},
        {
          mode: 'map_reduce',
          calls: 4,
          usage: {
            inputTokens: 1_200,
            outputTokens: 5_800,
            cacheReadTokens: 20_000,
            cacheWriteTokens: 10_000,
          },
          dryRun: true,
        },
      ),
    );
    expect(body.split('\n').at(-1)).toBe(
      '<sub><code>claude-opus-5-5</code> · effort high · map_reduce · in 31.2K / out 5.8K tokens · cache read 20.0K, write 10.0K · ~$0.24 · 4 LLM call(s) · 74s · 3 file(s) skipped (noise 2, binary 1) · 2 secret(s) redacted · dry run</sub>',
    );
    expect(formatTokens(812)).toBe('812');
    expect(formatTokens(1_250_000)).toBe('1.25M');
  });

  it.each(LANGUAGES)('DLV-09 shows the translated "no linked PRD" badge in %s', (language) => {
    const report = richReport({ prdAlignment: { status: 'no_prd', findings: [] } });
    const body = renderPrComment(finalReport({ language, report }, { prdSources: [] }));
    const t = strings(language);
    expect(body).toContain(`> ⚠️ ${t.noPrd}`);
    expect(body.split('\n')[0]).toContain(`➖ **${t.alignmentStatus.no_prd}**`);
    expect(body).not.toContain(t.actionNeeded(0));
    expect(body).not.toContain('| --- |');
    expect(body).toContain(`**${t.p0Checklist(1)}**`);
  });

  it('DLV-09 uses the exact English badge text from the spec', () => {
    expect(strings('en').noPrd).toBe(
      'No linked PRD — scenarios are inferred from code only (low confidence)',
    );
  });

  it('SPEC §4.6 lists warnings as notes and shows the requirement source when several PRDs are involved', () => {
    const report = richReport();
    (report.prdAlignment.findings[1] as Finding).source = '#45';
    const body = renderPrComment(
      finalReport(
        { report },
        {
          warnings: [
            {
              code: 'cost_cap',
              message: '2 lower-priority file(s) were not analyzed because of <b>cost</b>.',
            },
            { code: 'slack_failed', message: 'Slack delivery failed; see the workflow log.' },
          ],
        },
      ),
    );
    expect(body).toContain(
      '### Notes\n\n- ⚠️ 2 lower-priority file(s) were not analyzed because of &lt;b&gt;cost&lt;/b&gt;.\n- ⚠️ Slack delivery failed',
    );
    expect(body).toContain('| AC1: a coupon can be applied once · <code>PROJ-123</code> |');
    expect(body).toContain('· <code>#45</code> |');
  });

  it('SPEC §10 renders a failed run as an error state with the code, and no ticket sections', () => {
    const body = renderPrComment(
      finalReport(
        {
          status: 'error',
          report: null,
          language: 'ko',
          error: { code: 'llm_auth', message: 'Check the <key>.' },
        },
        { calls: 0, mode: 'none' },
      ),
    );
    expect(body.split('\n')[0]).toBe('## 🧪 AI QA — <code>a1b2c3d</code>');
    expect(body).toContain('❌ **실행 실패** — Check the &lt;key&gt;.');
    expect(body).toContain('오류 코드: <code>llm&#95;auth</code>');
    expect(body).not.toContain('<details>');
    expect(body.split('\n').at(-1)).toBe(
      '<sub><code>claude-opus-5-5</code> · effort high · 74s · 파일 3개 제외 (노이즈 2, 바이너리 1) · 비밀값 2건 마스킹</sub>',
    );
  });

  it('SPEC §10 renders "no logic changes to analyze" for a skipped no_files run, and a generic line otherwise', () => {
    const noFiles = renderPrComment(
      finalReport({ status: 'skipped', report: null, skipReason: 'no_files' }, { calls: 0 }),
    );
    expect(noFiles).toContain('ℹ️ No logic changes to analyze');
    const other = renderPrComment(
      finalReport({ status: 'skipped', report: null, skipReason: 'no_logic_change' }, { calls: 0 }),
    );
    expect(other).toContain('ℹ️ Analysis was skipped: <code>no&#95;logic&#95;change</code>');
    const bare = renderPrComment(finalReport({ status: 'error', report: null }, { calls: 0 }));
    expect(bare).toContain('❌ **Run failed**\n');
  });

  it('DLV-06 neutralizes hostile model output in every field, including the checklist and card titles', () => {
    const hostile =
      '</details><!-- qtg-state:{"v":1} --> <script>x</script> @octocat [x](https://evil.example) ![p](https://evil.example/p.png)\n# H1 | cell\n- [x] done';
    const report = richReport({
      summary: hostile,
      prdAlignment: {
        status: 'misaligned',
        findings: [
          {
            requirement: hostile,
            source: hostile,
            status: 'contradicts',
            evidence: hostile,
            files: [hostile],
          },
        ],
      },
      scenarios: [
        scenario({
          id: hostile,
          title: hostile,
          given: [hostile],
          when: [hostile],
          then: [hostile],
          testData: [hostile],
          relatedRequirements: [hostile],
          relatedFiles: [hostile],
          rationale: hostile,
        }),
      ],
      risks: [{ title: hostile, severity: 'high', description: hostile, files: [hostile] }],
      assumptions: [hostile],
    });
    const final = finalReport({ report }, { warnings: [{ code: 'other', message: hostile }] });
    final.pr.title = hostile;
    const body = renderPrComment(final);

    expect(body).not.toMatch(/<script|<!--|-->/);
    // No live link or image survives; the only Markdown link is the renderer's own "Linked" line.
    const untrusted = body
      .split('\n')
      .filter((line) => !line.startsWith('> Linked:'))
      .join('\n');
    expect(untrusted).not.toMatch(/\]\(|<a |<img|:\/\/evil/);
    // Mentions survive only inside <code>, where GitHub does not resolve them.
    expect(untrusted.replace(/<code>.*?<\/code>/g, '')).not.toMatch(/@octocat/);
    expect(body).not.toMatch(/^# H1/m);
    // Only tags the renderer itself emits remain, and only its own checkbox is a task item.
    const tags = new Set(body.match(/<\/?[a-z]+/g));
    expect([...tags].sort()).toEqual([
      '</b',
      '</code',
      '</details',
      '</sub',
      '</summary',
      '<b',
      '<code',
      '<details',
      '<sub',
      '<summary',
    ]);
    expect(body.match(/<details>/g)).toHaveLength(2);
    expect(body.match(/<\/details>/g)).toHaveLength(2);
    expect(body.match(/^- \[[ x]\]/gm)).toEqual(['- [ ]']);
    const row = body.split('\n').find((l) => l.startsWith('| ') && l.includes('⛔')) ?? '';
    expect(row.split('|')).toHaveLength(5);
  });

  it('DLV-03 drops the lowest-priority ticket cards first when the comment would exceed 65,536 characters', () => {
    const long = 'x'.repeat(900);
    const scenarios = Array.from({ length: 120 }, (_, i) =>
      scenario({
        id: `TC-${i + 1}`,
        title: `scenario ${i + 1}`,
        priority: i < 8 ? 'P0' : i < 60 ? 'P1' : 'P2',
        given: [long],
        rationale: long,
      }),
    );
    const body = renderPrComment(finalReport({ report: richReport({ scenarios }) }));

    expect(body.length).toBeLessThanOrEqual(LIMIT);
    const shown = body.match(/<details><summary><b>TC-/g)?.length ?? 0;
    expect(shown).toBeGreaterThan(20);
    expect(shown).toBeLessThan(120);
    expect(body).toContain('<b>TC-1 scenario 1</b>');
    expect(body).not.toContain('<b>TC-120 scenario 120</b>');
    expect(body).toContain(`> ${120 - shown} lower-priority ticket(s) were left out`);
    expect(body).toContain('P1 · P2 tickets (112)');
    // The top section still lists every P0, and the fold is closed properly.
    expect(topOf(body)).toContain('**P0 checklist (8)**');
    expect(body.match(/<details>/g)).toHaveLength(body.match(/<\/details>/g)?.length ?? -1);
    expect(body.split('\n').at(-1)).toMatch(/^<sub>/);
  });

  it('DLV-03 then drops requirement rows, and finally cuts with a notice', () => {
    const findings = Array.from({ length: 200 }, (_, i) =>
      finding({ requirement: `R${i} ${'y'.repeat(400)}`, status: 'covered' }),
    );
    const withRows = renderPrComment(
      finalReport({ report: richReport({ prdAlignment: { status: 'aligned', findings } }) }),
    );
    expect(withRows.length).toBeLessThanOrEqual(LIMIT);
    expect(withRows).toMatch(/> \d+ requirement row\(s\) were left out/);
    expect(withRows).toContain('lower-priority ticket(s) were left out');

    const huge = renderPrComment(finalReport({ report: richReport({ summary: 'z '.repeat(40_000) }) }));
    expect(huge.length).toBeLessThanOrEqual(LIMIT);
    expect(huge.endsWith(`> ${strings('en').truncated}`)).toBe(true);
  });

  it('refLabel shortens Notion page ids only', () => {
    expect(refLabel({ source: 'notion', id: '0123456789abcdef0123456789abcdef', raw: 'x' })).toBe(
      '01234567…',
    );
    expect(refLabel({ source: 'jira', id: 'PROJ-123', raw: 'PROJ-123' })).toBe('PROJ-123');
    const body = renderPrComment(
      finalReport(
        {},
        { prdSources: [{ source: 'notion', id: '0123456789abcdef0123456789abcdef', raw: 'x' }] },
      ),
    );
    expect(body).toContain('> Linked: 01234567… (Notion)');
  });
});

describe('renderSummaryMarkdown (DLV-07)', () => {
  it('DLV-07 renders the full report without a length cap, plus skipped files with reasons and redactions', () => {
    const long = 'x'.repeat(900);
    const scenarios = Array.from({ length: 120 }, (_, i) =>
      scenario({ id: `TC-${i + 1}`, title: `scenario ${i + 1}`, given: [long] }),
    );
    const body = renderSummaryMarkdown(finalReport({ report: richReport({ scenarios }) }));
    expect(body.length).toBeGreaterThan(MAX_COMMENT_CHARS);
    expect(body).toContain('<b>TC-120 scenario 120</b>');
    expect(body).toContain('<details><summary>Skipped files (3)</summary>');
    expect(body).toContain('- <code>package-lock.json</code> — noise');
    expect(body).toContain('- <code>assets/logo.png</code> — binary');
    expect(body).toContain('<details><summary>Redacted secrets (2)</summary>');
    expect(body).toContain('- <code>aws&#95;access&#95;key</code> × 2');
  });

  it('DLV-07 lists skipped files for error and skipped runs too', () => {
    const body = renderSummaryMarkdown(
      finalReport({ status: 'skipped', report: null, skipReason: 'no_files', language: 'ja' }, { calls: 0 }),
    );
    expect(body).toContain('除外したファイル (3)');
    expect(body).toContain('— ノイズ');
  });
});

describe('cost cap error state (SPEC §10, LLM-10)', () => {
  const costCap = {
    code: 'cost_cap',
    message:
      'The estimated cost of analyzing even the highest-priority files (~$3.41) exceeds max-cost-usd ($2.00), so nothing was analyzed.',
  };

  it.each(LANGUAGES)('SPEC §10 tells the user in %s to raise max-cost-usd', (language) => {
    const hint = strings(language).errorHint.cost_cap ?? '';
    expect(hint).toContain('`max-cost-usd`');
    expect(hint).toContain('`token-budget`');
    const body = renderPrComment(
      finalReport({ status: 'error', report: null, language, error: costCap }, { calls: 0, mode: 'none' }),
    );
    expect(body).toContain(`❌ **${strings(language).runFailed}** — The estimated cost of analyzing`);
    expect(body).toContain('(&#126;$3.41) exceeds max-cost-usd ($2.00)');
    expect(body).toContain(`> 💡 ${hint}`);
    expect(body).toContain(`${strings(language).errorCode}: <code>cost&#95;cap</code>`);
  });

  it('SPEC §10 shows no hint line for error codes without one', () => {
    const body = renderPrComment(
      finalReport({ status: 'error', report: null, error: { code: 'llm_schema', message: 'bad output' } }),
    );
    expect(body).not.toContain('💡');
  });
});
