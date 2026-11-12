/** Notion blocks → Markdown (PRD-05). Owner: qa-work-session-a. */
import type { BlockObjectResponse, RichTextItemResponse } from '@notionhq/client';
import { codeSpan, fencedCode, hang, markdownTable, quote, tidy, wrapInline } from './md';

/** A fetched block with its (already fetched) children. */
export interface NotionNode {
  block: BlockObjectResponse;
  children: NotionNode[];
}

/** Notion rich text → inline Markdown (bold/italic/strike/code, links, inline equations). */
export function richTextToMarkdown(items: readonly RichTextItemResponse[] | undefined): string {
  if (!items) return '';
  return items
    .map((item) => {
      if (item.type === 'equation') return `$${item.equation.expression}$`;
      let out = item.plain_text;
      const a = item.annotations;
      if (a?.code) out = codeSpan(out);
      if (a?.strikethrough) out = wrapInline(out, '~~');
      if (a?.italic) out = wrapInline(out, '_');
      if (a?.bold) out = wrapInline(out, '**');
      if (item.href) out = wrapInline(out, '[', `](${item.href})`);
      return out;
    })
    .join('');
}

/** Sibling blocks rendered as one tight Markdown list ("- " items vs "1. " items). */
const LIST_FAMILY: Record<string, string> = {
  bulleted_list_item: 'bullet',
  to_do: 'bullet',
  toggle: 'bullet',
  numbered_list_item: 'number',
};
const sameList = (a: string, b: string): boolean =>
  LIST_FAMILY[a] !== undefined && LIST_FAMILY[a] === LIST_FAMILY[b];

function withChildren(text: string, node: NotionNode, marker: string): string {
  const kids = renderNodes(node.children);
  return hang(kids ? `${text}\n${kids}` : text, marker);
}

function render(node: NotionNode, ordinal: number): string {
  const b = node.block;
  const kids = () => renderNodes(node.children);
  switch (b.type) {
    case 'paragraph': {
      const text = richTextToMarkdown(b.paragraph.rich_text);
      const k = kids();
      return k ? `${text}\n\n${hang(k, '  ')}` : text;
    }
    case 'heading_1':
      return [`# ${richTextToMarkdown(b.heading_1.rich_text)}`, kids()].filter(Boolean).join('\n\n');
    case 'heading_2':
      return [`## ${richTextToMarkdown(b.heading_2.rich_text)}`, kids()].filter(Boolean).join('\n\n');
    case 'heading_3':
      return [`### ${richTextToMarkdown(b.heading_3.rich_text)}`, kids()].filter(Boolean).join('\n\n');
    case 'heading_4':
      return [`#### ${richTextToMarkdown(b.heading_4.rich_text)}`, kids()].filter(Boolean).join('\n\n');
    case 'bulleted_list_item':
      return withChildren(richTextToMarkdown(b.bulleted_list_item.rich_text), node, '- ');
    case 'numbered_list_item':
      return withChildren(richTextToMarkdown(b.numbered_list_item.rich_text), node, `${ordinal}. `);
    case 'to_do':
      return withChildren(richTextToMarkdown(b.to_do.rich_text), node, b.to_do.checked ? '- [x] ' : '- [ ] ');
    case 'toggle':
      return withChildren(richTextToMarkdown(b.toggle.rich_text), node, '- ');
    case 'quote':
      return quote([richTextToMarkdown(b.quote.rich_text), kids()].filter(Boolean).join('\n\n'));
    case 'callout': {
      const icon = b.callout.icon?.type === 'emoji' ? `${b.callout.icon.emoji} ` : '';
      return quote(
        [`${icon}${richTextToMarkdown(b.callout.rich_text)}`, kids()].filter(Boolean).join('\n\n'),
      );
    }
    case 'code': {
      const lang = b.code.language === 'plain text' ? '' : b.code.language;
      return fencedCode(b.code.rich_text.map((t) => t.plain_text).join(''), lang.replace(/\s+/g, '-'));
    }
    case 'equation':
      return `$$\n${b.equation.expression}\n$$`;
    case 'divider':
      return '---';
    case 'table': {
      const rows = node.children
        .map((c) => c.block)
        .filter((c) => c.type === 'table_row')
        .map((c) => c.table_row.cells.map((cell) => richTextToMarkdown(cell)));
      return markdownTable(rows);
    }
    case 'child_page':
      return `[Sub-page: ${b.child_page.title}]`;
    case 'child_database':
      return `[Database: ${b.child_database.title}]`;
    case 'bookmark':
    case 'embed':
    case 'link_preview': {
      const url =
        b.type === 'bookmark' ? b.bookmark.url : b.type === 'embed' ? b.embed.url : b.link_preview.url;
      const caption =
        b.type === 'link_preview'
          ? ''
          : richTextToMarkdown((b.type === 'bookmark' ? b.bookmark : b.embed).caption);
      return caption ? `[${caption}](${url})` : url;
    }
    case 'image':
    case 'video':
    case 'pdf':
    case 'file':
    case 'audio': {
      // File URLs are short-lived signed links; keep only the caption.
      const media = (b as unknown as Record<string, { caption?: RichTextItemResponse[] } | undefined>)[
        b.type
      ];
      const caption = richTextToMarkdown(media?.caption);
      return caption ? `[${b.type}: ${caption}]` : '';
    }
    case 'table_of_contents':
    case 'breadcrumb':
    case 'unsupported':
      return '';
    default: {
      // Containers (column_list, column, synced_block, template, tab, …) and types added later.
      const payload = (b as unknown as Record<string, { rich_text?: RichTextItemResponse[] } | undefined>)[
        b.type
      ];
      return [richTextToMarkdown(payload?.rich_text), kids()].filter(Boolean).join('\n\n');
    }
  }
}

/** Renders sibling blocks; consecutive list items are kept tight, numbered items are counted. */
export function renderNodes(nodes: readonly NotionNode[]): string {
  let out = '';
  let prev: string | null = null;
  let ordinal = 0;
  for (const node of nodes) {
    const type = node.block.type;
    ordinal = type === 'numbered_list_item' ? (prev === 'numbered_list_item' ? ordinal + 1 : 1) : 0;
    const md = render(node, ordinal);
    if (md.trim() === '') continue;
    if (out) out += prev && sameList(prev, type) ? '\n' : '\n\n';
    out += md;
    prev = type;
  }
  return out;
}

/**
 * Converts a fetched Notion block tree to Markdown. Sub-pages and databases are referenced by
 * title only; media keeps only captions (signed file URLs are dropped).
 */
export function notionToMarkdown(nodes: readonly NotionNode[]): string {
  return tidy(renderNodes(nodes));
}
