import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  flatten,
  isAllowedUrl,
  type LinkPolicy,
  linkPolicyFor,
  mdCode,
  mdInline,
  slackText,
  truncate,
} from '../../src/delivery/sanitize';
import { finalReport } from './support';

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
