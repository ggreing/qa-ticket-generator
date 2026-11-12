import { describe, expect, it } from 'vitest';
import { renderPrComment } from '../../src/delivery/render/markdown';
import { buildSummaryCard, buildThreadMessages } from '../../src/delivery/render/slack-blocks';
import {
  escapeHtml,
  flatten,
  isAllowedUrl,
  type LinkPolicy,
  linkPolicyFor,
  mdCode,
  mdInline,
  slackCodeText,
  slackText,
  truncate,
} from '../../src/delivery/sanitize';
import { finalReport, richReport } from './support';

const policy: LinkPolicy = linkPolicyFor(finalReport());
const ZWSP = '​';

describe('link allow-list (DLV-06)', () => {
  it('DLV-06 allows only the PR repository and the linked PRD documents', () => {
    expect(policy.allowed).toEqual([
      'github.com/acme/shop',
      'acme.atlassian.net/browse/proj-123',
      'github.com/acme/shop/issues/45',
    ]);
    expect(isAllowedUrl('https://github.com/acme/shop/pull/42', policy)).toBe(true);
    expect(isAllowedUrl('https://GitHub.com/acme/shop', policy)).toBe(true);
    expect(isAllowedUrl('https://acme.atlassian.net/browse/PROJ-123?focusedId=1#c', policy)).toBe(true);
  });

  it.each([
    ['another repo on the same host', 'https://github.com/evil/phish'],
    ['a look-alike repo name', 'https://github.com/acme/shop-evil/pull/1'],
    ['another ticket', 'https://acme.atlassian.net/browse/PROJ-999'],
    ['plain http', 'http://github.com/acme/shop'],
    ['userinfo trick', 'https://github.com@evil.example/acme/shop'],
    ['credentials in the URL', 'https://user:pw@github.com/acme/shop'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['not a URL', 'github.com/acme/shop'],
  ])('DLV-06 rejects %s', (_label, url) => {
    expect(isAllowedUrl(url, policy)).toBe(false);
  });

  it('DLV-06 ignores PRD references without a usable https URL', () => {
    const final = finalReport(
      {},
      {
        prdSources: [
          { source: 'notion', id: 'a'.repeat(32), raw: 'x' },
          { source: 'jira', id: 'X-1', raw: 'X-1', url: 'http://insecure.example/X-1' },
        ],
      },
    );
    expect(linkPolicyFor(final).allowed).toEqual(['github.com/acme/shop']);
  });
});

describe('mdInline (DLV-06)', () => {
  it.each([
    ['a script tag', '<script>alert(1)</script>', '&lt;script&gt;alert(1)&lt;/script&gt;'],
    ['a closing details tag', 'done</details><h1>pwned', 'done&lt;/details&gt;&lt;h1&gt;pwned'],
    ['a forged state marker', '<!-- qtg-state:{"v":1} -->', '&lt;!-- qtg-state:{"v":1} --&gt;'],
    ['an image tag', '<img src=x onerror=alert(1)>', '&lt;img src=x onerror=alert(1)&gt;'],
    ['an entity', 'a &amp; b & c', 'a &amp;amp; b &amp; c'],
  ])('DLV-06 escapes raw HTML: %s', (_label, input, expected) => {
    expect(mdInline(input, policy)).toBe(expected);
  });

  it('DLV-06 keeps code spans readable but inert, including HTML and Markdown inside them', () => {
    expect(mdInline('uses `Map<string, number>` here', policy)).toBe(
      'uses <code>Map&lt;string, number&gt;</code> here',
    );
    expect(mdInline('``a ` b`` and `x*y_z|w`', policy)).toBe(
      '<code>a &#96; b</code> and <code>x&#42;y&#95;z&#124;w</code>',
    );
    // Unbalanced or lone backtick runs are plain text, and what follows is still escaped.
    expect(mdInline('`<b>bold</b>', policy)).toBe('&#96;&lt;b&gt;bold&lt;/b&gt;');
    expect(mdInline('```', policy)).toBe('&#96;&#96;&#96;');
  });

  it('DLV-06 makes URLs and e-mail addresses inside code unlinkable', () => {
    expect(mdInline('call `https://evil.example/x` or `www.evil.example`', policy)).toBe(
      `call <code>https:${ZWSP}//evil.example/x</code> or <code>www${ZWSP}.evil.example</code>`,
    );
    expect(mdCode('ops@evil.example')).toBe(`<code>ops@${ZWSP}evil.example</code>`);
    expect(mdCode('packages/@scope/pkg/index.ts')).toBe('<code>packages/@scope/pkg/index.ts</code>');
  });

  it('DLV-06 keeps allow-listed links as anchors and strips the rest down to their label', () => {
    expect(mdInline('see [the PR](https://github.com/acme/shop/pull/42?a=1&b="2")', policy)).toBe(
      'see <a href="https://github.com/acme/shop/pull/42?a=1&amp;b=&quot;2&quot;">the PR</a>',
    );
    expect(mdInline('[https://evil.example](https://github.com/acme/shop)', policy)).toBe(
      `<a href="https://github.com/acme/shop">https:${ZWSP}//evil.example</a>`,
    );
    expect(mdInline('click [here](https://evil.example/login) now', policy)).toBe('click here now');
    expect(mdInline('[x](javascript:alert(1))', policy)).not.toMatch(/<a |\]\(/);
    expect(mdInline('[label](<https://evil.example/a> "title")', policy)).toBe('label');
  });

  it('DLV-06 never embeds images, even from an allowed host', () => {
    expect(mdInline('![pixel](https://evil.example/t.gif)', policy)).toBe('pixel');
    expect(mdInline('![logo](https://github.com/acme/shop/raw/logo.png)', policy)).toBe('logo');
  });

  it('DLV-06 leaves allowed bare URLs alone and turns other bare URLs into inert code', () => {
    expect(mdInline('ticket https://acme.atlassian.net/browse/PROJ-123.', policy)).toBe(
      'ticket https://acme.atlassian.net/browse/PROJ-123.',
    );
    expect(mdInline('go to https://evil.example/a?b=1, please', policy)).toBe(
      `go to <code>https:${ZWSP}//evil.example/a?b=1</code>, please`,
    );
    expect(mdInline('or www.evil.example/x', policy)).toBe(`or <code>www${ZWSP}.evil.example/x</code>`);
  });

  it('DLV-06 neutralizes mentions, reference links, table pipes and backslash escapes', () => {
    expect(mdInline('cc @octocat and @acme/core', policy)).toBe(`cc @${ZWSP}octocat and @${ZWSP}acme/core`);
    expect(mdInline('mail a@b.co', policy)).toBe(`mail a@${ZWSP}b.co`);
    expect(mdInline('[foo]: https://evil.example', policy)).toBe(
      `&#91;foo&#93;: <code>https:${ZWSP}//evil.example</code>`,
    );
    expect(mdInline('a | b \\| c', policy)).toBe('a &#124; b &#92;&#124; c');
  });

  it('DLV-06 flattens multi-line text so it cannot start a heading, list, fence or HTML block', () => {
    const out = mdInline('first\n# Heading\n- item\n```\n<div>\n\n| a |', policy);
    expect(out).not.toContain('\n');
    expect(out).toBe('first # Heading - item &#96;&#96;&#96; &lt;div&gt; &#124; a &#124;');
  });

  it('DLV-06 strips control, zero-width and bidi-override characters', () => {
    expect(flatten('a‮evil‬​\u0007b﻿')).toBe('aevilb');
    expect(flatten('  a \t\r\n b  ')).toBe('a b');
  });

  it('mdCode, escapeHtml and truncate behave as documented', () => {
    expect(mdCode('src/<x>/a_b*.ts')).toBe('<code>src/&lt;x&gt;/a&#95;b&#42;.ts</code>');
    expect(escapeHtml('<a href="x">&</a>')).toBe('&lt;a href="x"&gt;&amp;&lt;/a&gt;');
    expect(truncate('short', 10)).toBe('short');
    expect(truncate('a long sentence here', 10)).toBe('a long se…');
    expect(truncate('abc', 0)).toBe('…');
  });
});

describe('slackText (DLV-06)', () => {
  it('DLV-06 escapes &, < and >', () => {
    expect(slackText('a < b && c > d', policy)).toBe('a &lt; b &amp;&amp; c &gt; d');
  });

  it.each([
    ['<!channel>', '&lt;!channel&gt;'],
    ['<!here|here>', '&lt;!here|here&gt;'],
    ['<@U012ABCDEF>', '&lt;@U012ABCDEF&gt;'],
    ['<!subteam^S123|@team>', '&lt;!subteam^S123|@team&gt;'],
    ['<https://evil.example|Click me>', '&lt;hxxps://evil.example|Click me&gt;'],
  ])('DLV-06 disarms the special sequence %s', (input, expected) => {
    expect(slackText(input, policy)).toBe(expected);
  });

  it('DLV-06 breaks @channel, @here and @everyone but leaves ordinary @ text', () => {
    expect(slackText('ping @channel, @HERE and @everyone', policy)).toBe(
      `ping @${ZWSP}channel, @${ZWSP}HERE and @${ZWSP}everyone`,
    );
    expect(slackText('@hereafter user@example.com', policy)).toBe('@hereafter user@example.com');
  });

  it('DLV-06 defangs URLs outside the allow-list and keeps allowed ones', () => {
    expect(slackText('see http://evil.example/x. and www.evil.example', policy)).toBe(
      'see hxxp://evil.example/x. and www[.]evil.example',
    );
    expect(slackText('pr https://github.com/acme/shop/pull/42', policy)).toBe(
      'pr https://github.com/acme/shop/pull/42',
    );
  });

  it('DLV-06 flattens new lines so a field cannot inject extra mrkdwn lines', () => {
    expect(slackText('title\n> quoted\n• fake bullet', policy)).toBe('title &gt; quoted • fake bullet');
  });
});

describe('tilde ranges are not struck through (DLV-06)', () => {
  it('DLV-06 Markdown prose encodes "~" so GitHub cannot pair two of them into a strikethrough', () => {
    expect(mdInline('1~2초 후 재시도, 3~5회', policy)).toBe('1&#126;2초 후 재시도, 3&#126;5회');
    expect(mdInline('~~deleted~~ text', policy)).toBe('&#126;&#126;deleted&#126;&#126; text');
    expect(mdInline('about ~5 items', policy)).toBe('about &#126;5 items');
    // Code is encoded the same way; the entity shows as a plain tilde in Markdown and in raw HTML.
    expect(mdInline('`~/.config` and `a ~= b`', policy)).toBe(
      '<code>&#126;/.config</code> and <code>a &#126;= b</code>',
    );
    expect(mdCode('1~2')).toBe('<code>1&#126;2</code>');
  });

  it('DLV-06 Slack prose swaps "~" for a look-alike, and code spans keep the real one', () => {
    expect(slackText('1~2초 후 재시도, 3~5회', policy)).toBe('1∼2초 후 재시도, 3∼5회');
    expect(slackText('~struck~', policy)).not.toContain('~');
    expect(slackCodeText('retry = 1~2s', policy)).toBe('retry = 1~2s');
  });

  it.each([
    ['ko', '1~2초 후 재시도하고 3~5회까지 반복한다'],
    ['ja', '1~2秒後に再試行し、3~5回まで繰り返す'],
    ['zh-CN', '1~2 秒后重试,最多重复 3~5 次'],
  ] as const)(
    'DLV-06 a %s report with range notation renders without strikethrough (snapshot)',
    async (language, range) => {
      const base = richReport();
      const first = base.scenarios[0] as (typeof base.scenarios)[number];
      const report = richReport({
        summary: range,
        scenarios: [
          { ...first, title: range, given: [range], when: [range], then: [range], rationale: range },
        ],
        risks: [{ title: range, severity: 'medium', description: range, files: [] }],
        assumptions: [range],
      });
      (report.prdAlignment.findings[1] as (typeof report.prdAlignment.findings)[number]).evidence = range;
      const body = renderPrComment(finalReport({ language, report }));
      // The only literal tilde left is the renderer's own "~$0.24" in the footer, alone in its paragraph.
      expect(body.replace('~$0.24', '')).not.toContain('~');
      expect(body.match(/&#126;/g)?.length).toBeGreaterThanOrEqual(18);
      await expect(body).toMatchFileSnapshot(`../../fixtures/delivery/pr-comment.ranges.${language}.md.snap`);

      const slack = JSON.stringify([
        buildSummaryCard(finalReport({ language, report }), 'https://github.com/acme/shop/pull/42').blocks,
        buildThreadMessages(finalReport({ language, report })).map((m) => m.blocks),
      ]);
      expect(slack.replace('~$0.24', '')).not.toContain('~');
      expect(slack).toContain('1∼2');
    },
  );
});
