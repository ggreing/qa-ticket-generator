/**
 * Markdown → Atlassian Document Format for Jira descriptions and comments (SPEC v3 §5).
 * The reverse of src/context/prd/adf-to-md.ts. Owner: qa-work-session-a.
 *
 * ADF rules respected: list items start with a paragraph; task items hold inline content only and
 * carry `localId`s; `code` cannot be combined with other marks (except link); text nodes are never
 * empty; headings are not allowed inside list items or table cells (they become bold paragraphs).
 */
import type { AdfNode } from '../context/prd/adf-to-md';
import { type Block, type Inline, inlineText, parseMarkdown } from './md-parse';

export interface AdfDoc {
  type: 'doc';
  version: 1;
  content: AdfNode[];
}

type Ctx = { nextId: () => string };

function inlineToAdf(inline: Inline[]): AdfNode[] {
  const out: AdfNode[] = [];
  for (const run of inline) {
    if (run.type === 'break') {
      out.push({ type: 'hardBreak' });
      continue;
    }
    if (run.text === '') continue;
    const marks: { type: string; attrs?: Record<string, unknown> }[] = run.marks.includes('code')
      ? [{ type: 'code' }]
      : run.marks.map((m) => ({ type: m }));
    if (run.href) marks.push({ type: 'link', attrs: { href: run.href } });
    out.push({ type: 'text', text: run.text, ...(marks.length ? { marks } : {}) });
  }
  // A trailing hard break renders as an empty line; drop it.
  while (out.at(-1)?.type === 'hardBreak') out.pop();
  return out;
}

const paragraph = (inline: Inline[]): AdfNode => {
  const content = inlineToAdf(inline);
  return content.length ? { type: 'paragraph', content } : { type: 'paragraph' };
};

const strongParagraph = (inline: Inline[]): AdfNode =>
  paragraph(
    inline.map((r) =>
      r.type === 'text' ? { ...r, marks: [...new Set([...r.marks, 'strong' as const])] } : r,
    ),
  );

/** Converts blocks; `nested` blocks (list items, cells, quotes) cannot hold headings or tables. */
function blocksToAdf(blocks: Block[], ctx: Ctx, nested: boolean): AdfNode[] {
  return blocks.flatMap((b): AdfNode[] => {
    switch (b.type) {
      case 'heading':
        return nested
          ? [strongParagraph(b.inline)]
          : [{ type: 'heading', attrs: { level: b.level }, content: inlineToAdf(b.inline) }];
      case 'paragraph':
        return [paragraph(b.inline)];
      case 'code':
        return [
          {
            type: 'codeBlock',
            ...(b.lang ? { attrs: { language: b.lang } } : {}),
            ...(b.text ? { content: [{ type: 'text', text: b.text }] } : {}),
          },
        ];
      case 'quote':
        return [
          {
            type: 'blockquote',
            content: blocksToAdf(b.blocks, ctx, true).filter((n) => n.type !== 'codeBlock'),
          },
        ];
      case 'rule':
        return nested ? [] : [{ type: 'rule' }];
      case 'table':
        if (nested) {
          return [b.header, ...b.rows].map((row) =>
            paragraph(
              row.flatMap((c, i) => (i ? [{ type: 'text' as const, text: ' | ', marks: [] }, ...c] : c)),
            ),
          );
        }
        return [
          {
            type: 'table',
            attrs: { isNumberColumnEnabled: false, layout: 'default' },
            content: [
              {
                type: 'tableRow',
                content: b.header.map((c) => ({ type: 'tableHeader', attrs: {}, content: [paragraph(c)] })),
              },
              ...b.rows.map((row) => ({
                type: 'tableRow',
                content: Array.from({ length: b.header.length }, (_, i) => ({
                  type: 'tableCell',
                  attrs: {},
                  content: [paragraph(row[i] ?? [])],
                })),
              })),
            ],
          },
        ];
      case 'list':
        return [listToAdf(b, ctx)];
    }
    return [];
  });
}

function listToAdf(b: Extract<Block, { type: 'list' }>, ctx: Ctx): AdfNode {
  if (b.items.length > 0 && b.items.every((it) => it.checked !== null)) {
    return {
      type: 'taskList',
      attrs: { localId: ctx.nextId() },
      content: b.items.map((it) => {
        // Task items take inline content only: fold their blocks into one line set.
        const inline: Inline[] = [];
        for (const blk of it.blocks) {
          const text: Inline[] =
            blk.type === 'paragraph' || blk.type === 'heading'
              ? blk.inline
              : [{ type: 'text', text: blk.type === 'code' ? blk.text : flatText(blk), marks: [] }];
          if (inline.length) inline.push({ type: 'break' });
          inline.push(...text);
        }
        const content = inlineToAdf(inline);
        return {
          type: 'taskItem',
          attrs: { localId: ctx.nextId(), state: it.checked ? 'DONE' : 'TODO' },
          ...(content.length ? { content } : {}),
        };
      }),
    };
  }
  return {
    type: b.ordered ? 'orderedList' : 'bulletList',
    ...(b.ordered ? { attrs: { order: b.start } } : {}),
    content: b.items.map((it) => {
      const content = blocksToAdf(it.blocks, ctx, true);
      if (content[0]?.type !== 'paragraph') content.unshift({ type: 'paragraph' });
      return { type: 'listItem', content };
    }),
  };
}

function flatText(b: Block): string {
  switch (b.type) {
    case 'heading':
    case 'paragraph':
      return inlineText(b.inline);
    case 'code':
      return b.text;
    case 'quote':
      return b.blocks.map(flatText).join('\n');
    case 'list':
      return b.items.map((it) => it.blocks.map(flatText).join(' ')).join('\n');
    case 'table':
      return [b.header, ...b.rows].map((r) => r.map(inlineText).join(' | ')).join('\n');
    case 'rule':
      return '';
  }
}

/** Markdown → ADF `doc`. Deterministic: the same Markdown always gives the same document. */
export function markdownToAdf(markdown: string): AdfDoc {
  let n = 0;
  const ctx: Ctx = { nextId: () => `qtg-${++n}` };
  return { type: 'doc', version: 1, content: blocksToAdf(parseMarkdown(markdown), ctx, false) };
}

/** ADF text node helpers for content the sinks build directly (payload expand, comments). */
export const adfText = (
  text: string,
  marks?: { type: string; attrs?: Record<string, unknown> }[],
): AdfNode => ({
  type: 'text',
  text,
  ...(marks?.length ? { marks } : {}),
});
