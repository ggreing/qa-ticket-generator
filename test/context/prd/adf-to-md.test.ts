import { describe, expect, it } from 'vitest';
import { adfToMarkdown } from '../../../src/context/prd/adf-to-md';
import { fixture } from '../helpers';

const doc = (...content: unknown[]) => ({ type: 'doc', version: 1, content });
const p = (...content: unknown[]) => ({ type: 'paragraph', content });
const t = (text: string, ...marks: unknown[]) => ({ type: 'text', text, ...(marks.length ? { marks } : {}) });

describe('adfToMarkdown', () => {
  it('PRD-04 converts the synthetic Jira description fixture', () => {
    const issue = fixture<{ fields: { description: unknown } }>('jira/issue-coupon.json');
    expect(adfToMarkdown(issue.fields.description)).toBe(
      [
        '## Background',
        '',
        'Shoppers enter a **coupon code** in _Checkout_. See `CouponService.apply()` and the [pricing doc](https://example.com/pricing).',
        'Owner: @Example Owner · Design: https://example.com/design/coupon',
        '',
        '## Acceptance Criteria',
        '',
        '- AC1: a coupon can be applied once per order',
        '  - also across devices',
        '- AC2: the discount shows before payment',
        '- AC3: expired coupons are rejected',
        '',
        '## Rollout',
        '',
        '3. Staff only',
        '4. Everyone',
        '',
        '- [x] Copy reviewed',
        '- [ ] Analytics event',
        '  - [ ] Dashboard',
        '',
        '```json',
        '{ "code": "SAVE10" }',
        '```',
        '',
        '> Legal: no stacking of coupons.',
        '',
        '| Code | Discount |',
        '| --- | --- |',
        '| SAVE10 | 10% \\| max 5 |',
        '',
        '---',
        '',
        '> Ships behind a flag.',
        '',
        'Unknown container text',
      ].join('\n'),
    );
  });

  it('PRD-04 keeps whitespace outside marks and nests marks', () => {
    const md = adfToMarkdown(
      doc(
        p(
          t('bold ', { type: 'strong' }),
          t('both', { type: 'strong' }, { type: 'em' }),
          t(' gone', { type: 'strike' }),
          t('a`b', { type: 'code' }),
        ),
      ),
    );
    expect(md).toBe('**bold** **_both_** ~~gone~~`` a`b ``');
  });

  it('PRD-04 renders inline extras: mention without @, emoji, status, date, cards', () => {
    const md = adfToMarkdown(
      doc(
        p(
          { type: 'mention', attrs: { id: 'x', text: 'Sam' } },
          t(' '),
          { type: 'emoji', attrs: { shortName: ':tada:', text: '🎉' } },
          t(' '),
          { type: 'status', attrs: { text: 'DONE' } },
          t(' '),
          { type: 'date', attrs: { timestamp: '1767225600000' } },
          { type: 'date', attrs: { timestamp: 'bogus' } },
        ),
        { type: 'blockCard', attrs: { url: 'https://example.com/card' } },
      ),
    );
    expect(md).toBe('@Sam 🎉 [DONE] 2026-01-01\n\nhttps://example.com/card');
  });

  it('PRD-04 handles headings, expands and code fences containing backticks', () => {
    const md = adfToMarkdown(
      doc(
        { type: 'heading', attrs: { level: 9 }, content: [t('Deep'), { type: 'hardBreak' }, t('title')] },
        { type: 'heading', content: [t('No level')] },
        { type: 'expand', attrs: { title: 'Details' }, content: [p(t('hidden'))] },
        { type: 'nestedExpand', content: [p(t('untitled'))] },
        { type: 'codeBlock', content: [t('a ``` b')] },
      ),
    );
    expect(md).toBe(
      ['###### Deep title', '# No level', '**Details**\n\nhidden', 'untitled', '````\na ``` b\n````'].join(
        '\n\n',
      ),
    );
  });

  it('PRD-04 renders a table without header row and ragged rows', () => {
    const cell = (s: string) => ({ type: 'tableCell', content: [p(t(s))] });
    const md = adfToMarkdown(
      doc({
        type: 'table',
        content: [
          { type: 'tableRow', content: [cell('a'), cell('b')] },
          { type: 'tableRow', content: [cell('c')] },
          { type: 'notARow' },
        ],
      }),
    );
    expect(md).toBe('| a | b |\n| --- | --- |\n| c |  |');
    expect(adfToMarkdown(doc({ type: 'table', content: [] }))).toBe('');
  });

  it('PRD-04 converts a bare node and multi-paragraph list items', () => {
    expect(
      adfToMarkdown({
        type: 'bulletList',
        content: [{ type: 'listItem', content: [p(t('one')), p(t('two'))] }],
      }),
    ).toBe('- one\n  two');
    expect(adfToMarkdown({ type: 'listItem', content: [p(t('solo'))] })).toBe('- solo');
    expect(adfToMarkdown({ type: 'taskItem', attrs: { state: 'TODO' }, content: [t('task')] })).toBe(
      '- [ ] task',
    );
    expect(adfToMarkdown(t('just text'))).toBe('just text');
  });

  it('PRD-04 tolerates non-ADF input and malformed nodes', () => {
    expect(adfToMarkdown(null)).toBe('');
    expect(adfToMarkdown('plain')).toBe('');
    expect(adfToMarkdown([1, 2])).toBe('');
    expect(adfToMarkdown(doc(p(t('ok')), 'junk', null, { type: 'paragraph', content: 'nope' }))).toBe('ok');
    expect(adfToMarkdown(doc({ type: 'media' }, p({ type: 'text', text: 42 })))).toBe('42');
  });

  it('PRD-04 stops at absurd nesting depth instead of overflowing the stack', () => {
    let node: Record<string, unknown> = p(t('deep'));
    for (let i = 0; i < 5_000; i++) node = { type: 'blockquote', content: [node] };
    expect(() => adfToMarkdown(doc(node))).not.toThrow();
  });
});
