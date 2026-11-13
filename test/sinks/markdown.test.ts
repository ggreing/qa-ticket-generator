import { describe, expect, it } from 'vitest';
import { adfToMarkdown } from '../../src/context/prd/adf-to-md';
import { parseInline, parseMarkdown } from '../../src/sinks/md-parse';
import { markdownToAdf } from '../../src/sinks/md-to-adf';
import { markdownToNotion } from '../../src/sinks/md-to-notion';
import { baseCase, render } from './support';

/** Typed view of a loosely typed block request, for assertions. */
const view = <T>(x: unknown): T => x as T;

describe('parseMarkdown (session b subset)', () => {
  it('§5 parses headings, bullet and numbered lists, bold and code, and unescapes b’s escapes', () => {
    const blocks = parseMarkdown(
      [
        '### 단계',
        '1. 결제 화면 진입',
        '2. 쿠폰 \\`EXP1\\` 입력',
        '',
        '- 금액 30,000원 \\& 수수료 \\| 없음 \\~ 50\\%',
        '',
        '**"만료된 쿠폰입니다" 토스트 노출**',
        '`https://shop.example/coupon`',
      ].join('\n'),
    );
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'list', 'list', 'paragraph']);
    const ordered = blocks[1] as Extract<(typeof blocks)[number], { type: 'list' }>;
    expect(ordered.ordered).toBe(true);
    expect(ordered.items).toHaveLength(2);
    const bullet = blocks[2] as Extract<(typeof blocks)[number], { type: 'list' }>;
    expect(bullet.items[0]?.blocks[0]).toEqual({
      type: 'paragraph',
      inline: [{ type: 'text', text: '금액 30,000원 & 수수료 | 없음 ~ 50\\%', marks: [] }],
    });
    const para = blocks[3] as Extract<(typeof blocks)[number], { type: 'paragraph' }>;
    expect(para.inline).toEqual([
      { type: 'text', text: '"만료된 쿠폰입니다" 토스트 노출', marks: ['strong'] },
      { type: 'break' },
      { type: 'text', text: 'https://shop.example/coupon', marks: ['code'] },
    ]);
  });

  it('§5 handles the wider GFM subset: nesting, tasks, fences, quotes, tables, rules, links', () => {
    const blocks = parseMarkdown(
      [
        '- a',
        '  - nested',
        '- [x] done',
        '',
        '```json',
        '{ "a": 1 }',
        '```',
        '> quoted',
        '',
        '| A | B |',
        '| --- | --- |',
        '| 1 | 2 \\| 3 |',
        '',
        '---',
        'see [docs](https://x.example) and <https://y.example>',
      ].join('\n'),
    );
    // CommonMark: "- a" and "- [x] done" are one list; the task is its second item.
    expect(blocks.map((b) => b.type)).toEqual(['list', 'code', 'quote', 'table', 'rule', 'paragraph']);
    const first = blocks[0] as Extract<(typeof blocks)[number], { type: 'list' }>;
    expect(first.items[0]?.blocks.map((b) => b.type)).toEqual(['paragraph', 'list']);
    expect(first.items.map((it) => it.checked)).toEqual([null, true]);
    expect((blocks[3] as Extract<(typeof blocks)[number], { type: 'table' }>).rows[0]?.[1]).toEqual([
      { type: 'text', text: '2 | 3', marks: [] },
    ]);
  });

  it('§5 reads b’s escaped line-start markers as text, not lists or rules', () => {
    const blocks = parseMarkdown(
      ['1\\. 이건 목록 아님', '', '\\- 이것도', '', '\\---', '', '\\===', '', '\\+ 더하기'].join('\n'),
    );
    expect(blocks.map((b) => b.type)).toEqual([
      'paragraph',
      'paragraph',
      'paragraph',
      'paragraph',
      'paragraph',
    ]);
    expect(
      blocks.map((b) =>
        b.type === 'paragraph' ? b.inline.map((r) => (r.type === 'text' ? r.text : '\n')).join('') : '',
      ),
    ).toEqual(['1. 이건 목록 아님', '- 이것도', '---', '===', '+ 더하기']);
  });

  it('§5 keeps snake_case and lone markers literal', () => {
    expect(parseInline('user_id and file_name')).toEqual([
      { type: 'text', text: 'user_id and file_name', marks: [] },
    ]);
    expect(parseInline('2 * 3 = 6')).toEqual([{ type: 'text', text: '2 * 3 = 6', marks: [] }]);
    expect(parseInline('_em_ ~~gone~~')).toEqual([
      { type: 'text', text: 'em', marks: ['em'] },
      { type: 'text', text: ' ', marks: [] },
      { type: 'text', text: 'gone', marks: ['strike'] },
    ]);
  });
});

describe('markdownToAdf', () => {
  it('§5 converts a rendered case to valid ADF that reads back as the same text', () => {
    const r = render(baseCase());
    const doc = markdownToAdf(r.markdown);
    expect(doc.type).toBe('doc');
    expect(doc.content.map((n) => n.type)).toEqual([
      'heading',
      'bulletList',
      'heading',
      'bulletList',
      'heading',
      'orderedList',
      'heading',
      'paragraph',
      'paragraph',
    ]);
    const md = adfToMarkdown(doc);
    expect(md).toContain('### 단계\n\n1. 결제 화면 진입\n2. 쿠폰 EXP1 입력 후 적용');
    expect(md).toContain('**"만료된 쿠폰입니다" 토스트 노출**');
    expect(md).toContain('주문 금액 30,000원 장바구니');
  });

  it('§5 obeys ADF rules: list items start with a paragraph, code marks stand alone, task items get ids', () => {
    const doc = markdownToAdf(
      ['- ### heading in item', '- [ ] task one', '', '**`bold code`**', '- [ ] t2'].join('\n'),
    );
    const list = doc.content[0] as {
      content: { content: { type: string; content: { marks?: unknown[] }[] }[] }[];
    };
    expect(list.content[0]?.content[0]?.type).toBe('paragraph');
    expect(list.content[0]?.content[0]?.content[0]?.marks).toEqual([{ type: 'strong' }]);
    const code = (doc.content.find((n) => n.type === 'paragraph') as { content: { marks: unknown[] }[] })
      .content[0];
    expect(code?.marks).toEqual([{ type: 'code' }]);
    const task = doc.content.find((n) => n.type === 'taskList') as {
      attrs: { localId: string };
      content: { attrs: unknown }[];
    };
    expect(task.attrs.localId).toMatch(/^qtg-\d+$/);
    expect(task.content[0]?.attrs).toMatchObject({ state: 'TODO' });
    // Deterministic: the same Markdown gives the same document (ids included).
    expect(markdownToAdf('- [ ] a\n- [x] b')).toEqual(markdownToAdf('- [ ] a\n- [x] b'));
  });

  it('§5 builds tables, quotes and rules at the top level and flattens them inside list items', () => {
    const top = markdownToAdf(
      ['| A | B |', '| --- | --- |', '| 1 |', '', '> ### q', '> ```', '> x', '> ```', '', '---'].join('\n'),
    );
    expect(top.content.map((n) => n.type)).toEqual(['table', 'blockquote', 'rule']);
    const table = top.content[0] as { content: { content: { type: string }[] }[] };
    expect(table.content[0]?.content.map((c) => c.type)).toEqual(['tableHeader', 'tableHeader']);
    expect(table.content[1]?.content).toHaveLength(2); // ragged row padded to the header width
    const quote = top.content[1] as { content: { type: string; content?: { marks?: unknown[] }[] }[] };
    expect(quote.content.map((n) => n.type)).toEqual(['paragraph']); // heading → bold paragraph, code dropped
    expect(quote.content[0]?.content?.[0]?.marks).toEqual([{ type: 'strong' }]);

    const nested = markdownToAdf(
      ['- item', '', '  | A | B |', '  | --- | --- |', '  | 1 | 2 |', '', '  ---'].join('\n'),
    );
    const item = (nested.content[0] as { content: { content: { type: string }[] }[] }).content[0];
    expect(item?.content.map((n) => n.type)).toEqual(['paragraph', 'paragraph', 'paragraph']);
    expect(adfToMarkdown(nested)).toContain('A | B');
  });

  it('§5 folds non-text blocks of a task item into its line', () => {
    const doc = markdownToAdf(
      ['- [ ] check', '', '  ```', '  code here', '  ```', '- [x] other', '', '  > quoted'].join('\n'),
    );
    const task = doc.content[0] as { content: { content: { type: string; text?: string }[] }[] };
    expect(task.content[0]?.content.map((n) => n.text ?? n.type)).toEqual([
      'check',
      'hardBreak',
      'code here',
    ]);
    expect(task.content[1]?.content.map((n) => n.text ?? n.type)).toEqual(['other', 'hardBreak', 'quoted']);
  });

  it('§5 never emits empty text nodes or a trailing hard break', () => {
    const doc = markdownToAdf('a  \nb\n\n**x**');
    const json = JSON.stringify(doc);
    expect(json).not.toContain('"text":""');
    expect(markdownToAdf('').content).toEqual([]);
  });
});

describe('markdownToNotion', () => {
  it('§5 converts a rendered case into Notion blocks', () => {
    const blocks = markdownToNotion(render(baseCase()).markdown, 1);
    expect(blocks.map((b) => b.type)).toEqual([
      'heading_3',
      'bulleted_list_item',
      'bulleted_list_item',
      'heading_3',
      'bulleted_list_item',
      'bulleted_list_item',
      'heading_3',
      'numbered_list_item',
      'numbered_list_item',
      'heading_3',
      'paragraph',
      'paragraph',
    ]);
    const expected = view<{
      paragraph: { rich_text: { text: { content: string }; annotations: { bold: boolean } }[] };
    }>(blocks[10]);
    expect(expected.paragraph.rich_text[0]?.annotations.bold).toBe(true);
    expect(expected.paragraph.rich_text.map((t) => t.text.content).join('')).toContain(
      '토스트 노출\n결제 금액',
    );
  });

  it('§5 splits rich text at 2,000 characters, maps code languages and flattens past maxDepth', () => {
    const long = 'x'.repeat(4_500);
    const [para] = view<{ paragraph: { rich_text: { text: { content: string } }[] } }[]>(
      markdownToNotion(long),
    );
    expect(para?.paragraph.rich_text.map((t) => t.text.content.length)).toEqual([2000, 2000, 500]);
    const [code] = view<{ code: { language: string } }[]>(markdownToNotion('```ts\nconst a = 1\n```\n'));
    expect(code?.code.language).toBe('typescript');
    const [odd] = view<{ code: { language: string } }[]>(markdownToNotion('```weird\nx\n```'));
    expect(odd?.code.language).toBe('plain text');
    const nested = markdownToNotion('- a\n  - b', 1);
    expect(nested.map((b) => b.type)).toEqual(['bulleted_list_item', 'bulleted_list_item']);
    const kept = markdownToNotion('- a\n  - b', 2);
    expect(kept).toHaveLength(1);
    expect(
      view<{ bulleted_list_item: { children: unknown[] } }>(kept[0]).bulleted_list_item.children,
    ).toHaveLength(1);
  });

  it('§5 builds tables, quotes, to-dos and links', () => {
    const blocks = markdownToNotion(
      '| A | B |\n| --- | --- |\n| 1 | 2 |\n\n> q\n\n- [x] done\n\n[t](https://x.example)',
    );
    expect(blocks.map((b) => b.type)).toEqual(['table', 'quote', 'to_do', 'paragraph']);
    expect(view<{ table: { table_width: number } }>(blocks[0]).table).toMatchObject({ table_width: 2 });
    expect(view<{ to_do: { checked: boolean } }>(blocks[2]).to_do.checked).toBe(true);
    const link = view<{ paragraph: { rich_text: { text: { link: unknown } }[] } }>(blocks[3]).paragraph
      .rich_text[0];
    expect(link?.text.link).toEqual({ url: 'https://x.example' });
  });
});
