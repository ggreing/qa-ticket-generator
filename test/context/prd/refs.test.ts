import { describe, expect, it } from 'vitest';
import { extractPrdRefs, notionIdFromUrl, stripNonContent } from '../../../src/context/prd/refs';

const opts = { defaultOwner: 'acme', defaultRepo: 'shop', jiraProjectKeys: ['PROJ', 'WEB'], maxDocuments: 5 };
const ids = (body: string, o: Partial<typeof opts> = {}) =>
  extractPrdRefs(body, { ...opts, ...o }).map((r) => `${r.source}:${r.id}`);

const HEX = '0123456789abcdef0123456789abcdef';

describe('extractPrdRefs — GitHub', () => {
  it('PRD-01 recognizes #123, owner/repo#123 and issue URLs', () => {
    const refs = extractPrdRefs(
      'See #12, other/lib#3 and https://github.com/acme/web/issues/99 for details.',
      opts,
    );
    expect(refs).toEqual([
      { source: 'github', id: 'acme/shop#12', url: 'https://github.com/acme/shop/issues/12', raw: '#12' },
      {
        source: 'github',
        id: 'other/lib#3',
        url: 'https://github.com/other/lib/issues/3',
        raw: 'other/lib#3',
      },
      {
        source: 'github',
        id: 'acme/web#99',
        url: 'https://github.com/acme/web/issues/99',
        raw: 'https://github.com/acme/web/issues/99',
      },
    ]);
  });

  it('PRD-01 recognizes closing keywords', () => {
    expect(ids('Closes #7\nfixes acme/api#8\nResolves: https://github.com/acme/shop/issues/9')).toEqual([
      'github:acme/shop#7',
      'github:acme/api#8',
      'github:acme/shop#9',
    ]);
  });

  it('PRD-01 ignores /pull/ URLs, anchors, HTML entities and #0', () => {
    expect(
      ids(
        'Follow-up of https://github.com/acme/shop/pull/41 and https://github.com/acme/shop/pull/41#issuecomment-123 ' +
          'see https://example.com/docs#12 &#123; color:#fff issue #0 PR#5',
      ),
    ).toEqual([]);
  });

  it('PRD-01 keeps issue URLs with anchors', () => {
    expect(ids('https://github.com/acme/shop/issues/5#issuecomment-1')).toEqual(['github:acme/shop#5']);
  });

  it('PRD-01 dedupes the same issue written differently', () => {
    expect(ids('#7 acme/shop#7 https://github.com/acme/shop/issues/7 Acme/Shop#7')).toEqual([
      'github:acme/shop#7',
    ]);
  });
});

describe('extractPrdRefs — Jira', () => {
  it('PRD-01 always recognizes atlassian browse URLs', () => {
    const refs = extractPrdRefs('Spec: https://acme.atlassian.net/browse/OPS-42.', {
      ...opts,
      jiraProjectKeys: [],
    });
    expect(refs).toEqual([
      {
        source: 'jira',
        id: 'OPS-42',
        url: 'https://acme.atlassian.net/browse/OPS-42',
        raw: 'https://acme.atlassian.net/browse/OPS-42',
      },
    ]);
  });

  it('PRD-01 recognizes selectedIssue board URLs', () => {
    expect(ids('https://acme.atlassian.net/jira/software/projects/OPS/boards/1?selectedIssue=OPS-7')).toEqual(
      ['jira:OPS-7'],
    );
  });

  it('PRD-01 recognizes bare keys only for configured projects (no UTF-8 false positive)', () => {
    expect(ids('Implements PROJ-123 and web-9; encoding UTF-8, ISO-8601, SHA-256.')).toEqual([
      'jira:PROJ-123',
      'jira:WEB-9',
    ]);
    expect(ids('Implements PROJ-123', { jiraProjectKeys: [] })).toEqual([]);
  });

  it('PRD-01 recognizes keys in branch-like text but not inside unrelated URLs', () => {
    expect(ids('branch feature/PROJ-5-coupon, see https://example.com/PROJ-6/page')).toEqual(['jira:PROJ-5']);
  });

  it('PRD-01 merges a Markdown link text key with its URL', () => {
    const refs = extractPrdRefs('[PROJ-1](https://acme.atlassian.net/browse/PROJ-1)', opts);
    expect(refs).toEqual([
      { source: 'jira', id: 'PROJ-1', url: 'https://acme.atlassian.net/browse/PROJ-1', raw: 'PROJ-1' },
    ]);
  });

  it('PRD-01 ignores atlassian URLs without an issue key', () => {
    expect(ids('https://acme.atlassian.net/wiki/spaces/ENG/pages/1', { jiraProjectKeys: [] })).toEqual([]);
  });
});

describe('extractPrdRefs — Notion', () => {
  it('PRD-01 recognizes notion.so and notion.site URLs with 32-hex ids', () => {
    expect(
      ids(
        `PRD https://www.notion.so/acme/Coupon-Spec-${HEX}?pvs=4 and https://acme.notion.site/${HEX.replace('0', 'f')}`,
      ),
    ).toEqual([`notion:${HEX}`, `notion:${HEX.replace('0', 'f')}`]);
  });

  it('PRD-01 normalizes dashed UUIDs and prefers the p= peek parameter', () => {
    const uuid = '01234567-89ab-cdef-0123-456789abcdef';
    expect(ids(`https://notion.so/${uuid}`)).toEqual([`notion:${HEX}`]);
    const db = 'f'.repeat(32);
    expect(ids(`https://www.notion.so/acme/${db}?v=${'e'.repeat(32)}&p=${HEX}&pm=s`)).toEqual([
      `notion:${HEX}`,
    ]);
    expect(notionIdFromUrl('not a url')).toBeUndefined();
  });

  it('PRD-01 uppercase hex ids are normalized and URLs without ids ignored', () => {
    expect(ids(`https://www.notion.so/Spec-${HEX.toUpperCase()})`)).toEqual([`notion:${HEX}`]);
    expect(ids('https://www.notion.so/acme/Some-page')).toEqual([]);
  });
});

describe('extractPrdRefs — body handling', () => {
  it('PRD-01 ignores refs inside code blocks', () => {
    const body = ['Real: #1', '```md', 'Closes #2', 'PROJ-3', '```', '~~~', '#4', '~~~', 'After: #5'].join(
      '\n',
    );
    expect(ids(body)).toEqual(['github:acme/shop#1', 'github:acme/shop#5']);
  });

  it('PRD-01 ignores refs inside HTML comments (PR template examples)', () => {
    const body = [
      '<!-- Link your PRD, e.g. Closes #123 or https://acme.atlassian.net/browse/PROJ-1 -->',
      'Closes #9 <!-- not #10 --> and PROJ-2',
      '<!--',
      `  https://www.notion.so/Example-${HEX}`,
      '-->',
    ].join('\n');
    expect(ids(body)).toEqual(['github:acme/shop#9', 'jira:PROJ-2']);
  });

  it('PRD-01 treats unclosed fences and comments as running to the end', () => {
    expect(ids('#1\n```\n#2')).toEqual(['github:acme/shop#1']);
    expect(ids('#1 <!-- #2\n#3')).toEqual(['github:acme/shop#1']);
  });

  it('PRD-01 keeps order of appearance across sources and caps at maxDocuments', () => {
    const body = `PROJ-1 then #2 then https://www.notion.so/${HEX} then WEB-4 then #5 then #6`;
    expect(ids(body)).toEqual([
      'jira:PROJ-1',
      'github:acme/shop#2',
      `notion:${HEX}`,
      'jira:WEB-4',
      'github:acme/shop#5',
    ]);
    expect(ids(body, { maxDocuments: 2 })).toEqual(['jira:PROJ-1', 'github:acme/shop#2']);
    expect(ids(body, { maxDocuments: 0 })).toEqual([]);
  });

  it('PRD-01 handles empty bodies and CRLF', () => {
    expect(ids('')).toEqual([]);
    expect(ids('Closes #3\r\n```\r\n#4\r\n```\r\n')).toEqual(['github:acme/shop#3']);
  });

  it('stripNonContent keeps line count and inline backtick fences are not fences', () => {
    const body = 'a\n```js\nb\n```\nc <!-- d --> e';
    expect(stripNonContent(body).split('\n')).toHaveLength(5);
    expect(stripNonContent('```inline``` #1')).toContain('#1');
  });
});
