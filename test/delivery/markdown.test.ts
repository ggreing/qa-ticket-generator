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
import { fakeReport } from '../helpers/fakes';
import { finalReport, richReport } from './support';

const LANGUAGES: Language[] = ['en', 'ko', 'ja', 'zh-CN'];
const LIMIT = MAX_COMMENT_CHARS - STATE_RESERVE;
const scenario = (overrides: Partial<QaReport['scenarios'][number]>) => ({
  ...(fakeReport().scenarios[0] as QaReport['scenarios'][number]),
  ...overrides,
});

describe('renderPrComment', () => {
  it.each(LANGUAGES)('SPEC §4.6 renders the full comment in %s (snapshot)', async (language) => {
    const body = renderPrComment(finalReport({ language }));
    // `.md.snap` rather than `.md`, so the repo formatter leaves the exact rendered bytes alone.
    await expect(body).toMatchFileSnapshot(`../../fixtures/delivery/pr-comment.${language}.md.snap`);
  });

  it('SPEC §4.6 has the header with short SHA and alignment badge, the linked PRDs, table, folded scenarios and footer', () => {
    const body = renderPrComment(finalReport());
    const lines = body.split('\n');
    expect(lines[0]).toBe('## 🧪 AI QA Scenarios — <code>a1b2c3d</code> · ⚠️ PRD alignment: **Partial**');
    expect(body).toContain(
      '> Linked: [PROJ-123](https://acme.atlassian.net/browse/PROJ-123) (Jira), [acme/shop#45](https://github.com/acme/shop/issues/45) (GitHub)',
    );
    expect(body).toContain('| Requirement | Status | Evidence |');
    expect(body).toContain(
      '| AC3: expired coupons are rejected | ❌ missing | No expiry comparison in coupon.ts <code>src/coupon.ts</code> |',
    );
    expect(body).toContain('### Scenarios (3)');
    expect(body).toContain(
      '<details><summary><b>[P0][Edge] S-01 · Apply a coupon one second before expiry</b></summary>',
    );
    expect(body).toContain(
      '- **Given** a coupon that was never used\n- **And** two checkout tabs for the same cart\n- **When**',
    );
    expect(body).toContain('the other one gets a <code>COUPON&#95;ALREADY&#95;USED</code> error');
    expect(body.match(/<details>/g)).toHaveLength(body.match(/<\/details>/g)?.length ?? -1);
    expect(lines.at(-1)).toMatch(/^<sub>.*<\/sub>$/);
    // The renderer leaves the marker and the state block to the comment store.
    expect(body).not.toContain('qa-ticket-generator:report');
    expect(body).not.toContain('qtg-state');
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
    expect(body).toContain(`> ⚠️ ${strings(language).noPrd}`);
    expect(body).not.toContain(`### ${strings(language).sections.alignment}`);
    expect(body.split('\n')[0]).toContain(
      `➖ ${strings(language).alignment}: **${strings(language).alignmentStatus.no_prd}**`,
    );
  });

  it('DLV-09 uses the exact English badge text from the spec', () => {
    expect(strings('en').noPrd).toBe(
      'No linked PRD — scenarios are inferred from code only (low confidence)',
    );
  });

  it('SPEC §4.6 lists warnings as notes and shows the requirement source when several PRDs are involved', () => {
    const report = richReport();
    (report.prdAlignment.findings[1] as QaReport['prdAlignment']['findings'][number]).source = '#45';
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

  it('SPEC §10 renders a failed run as an error state with the code, and no scenario sections', () => {
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
    expect(body.split('\n')[0]).toBe('## 🧪 AI QA 시나리오 — <code>a1b2c3d</code>');
    expect(body).toContain('❌ **실행 실패** — Check the &lt;key&gt;.');
    expect(body).toContain('오류 코드: <code>llm&#95;auth</code>');
    expect(body).not.toContain('###');
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

  it('DLV-06 neutralizes hostile model output in every field', () => {
    const hostile =
      '</details><!-- qtg-state:{"v":1} --> <script>x</script> @octocat [x](https://evil.example) ![p](https://evil.example/p.png)\n# H1 | cell';
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
    // Only tags the renderer itself emits remain.
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
    expect(body.match(/<details>/g)).toHaveLength(1);
    expect(body.match(/<\/details>/g)).toHaveLength(1);
    // The table still has exactly three columns per row.
    const row = body.split('\n').find((l) => l.startsWith('| ') && l.includes('⛔')) ?? '';
    expect(row.split('|')).toHaveLength(5);
  });

  it('DLV-03 drops the lowest-priority scenarios first when the comment would exceed 65,536 characters', () => {
    const long = 'x'.repeat(900);
    const scenarios = Array.from({ length: 120 }, (_, i) =>
      scenario({
        id: `S-${i + 1}`,
        title: `scenario ${i + 1}`,
        priority: i < 40 ? 'P0' : i < 80 ? 'P1' : 'P2',
        given: [long],
        rationale: long,
      }),
    );
    const body = renderPrComment(finalReport({ report: richReport({ scenarios }) }));

    expect(body.length).toBeLessThanOrEqual(LIMIT);
    expect(body).toContain('### Scenarios (120)');
    const shown = body.match(/<details>/g)?.length ?? 0;
    expect(shown).toBeGreaterThan(20);
    expect(shown).toBeLessThan(120);
    expect(body).toContain('scenario 1</b>');
    expect(body).not.toContain('scenario 120</b>');
    expect(body).toContain(`> ${120 - shown} lower-priority scenario(s) were left out`);
    expect(body).toContain('Job Summary');
    expect(body).toContain('report.json');
    expect(body.split('\n').at(-1)).toMatch(/^<sub>/); // footer survives
  });

  it('DLV-03 then drops requirement rows, and finally cuts with a notice', () => {
    const template = fakeReport().prdAlignment.findings[0] as QaReport['prdAlignment']['findings'][number];
    const findings = Array.from({ length: 200 }, (_, i) => ({
      ...template,
      requirement: `R${i} ${'y'.repeat(400)}`,
    }));
    const withRows = renderPrComment(
      finalReport({ report: richReport({ prdAlignment: { status: 'aligned', findings } }) }),
    );
    expect(withRows.length).toBeLessThanOrEqual(LIMIT);
    expect(withRows).toMatch(/> \d+ requirement row\(s\) were left out/);
    expect(withRows).toContain('lower-priority scenario(s) were left out');

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
      scenario({ id: `S-${i + 1}`, title: `scenario ${i + 1}`, given: [long] }),
    );
    const body = renderSummaryMarkdown(finalReport({ report: richReport({ scenarios }) }));
    expect(body.length).toBeGreaterThan(MAX_COMMENT_CHARS);
    expect(body).toContain('scenario 120</b>');
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
