/**
 * Markdown → Notion block requests for case bodies (SPEC v3 §5). Owner: qa-work-session-a.
 *
 * Limits respected: rich_text items are cut at 2,000 characters; code languages outside Notion's
 * list become "plain text"; children are nested at most `maxDepth` levels below the caller's
 * block (the API accepts two levels per request), deeper list items are flattened into siblings.
 */
import { type Block, type Inline, inlineText, parseMarkdown } from './md-parse';

export interface NotionRichText {
  type: 'text';
  text: { content: string; link: { url: string } | null };
  annotations: {
    bold: boolean;
    italic: boolean;
    strikethrough: boolean;
    underline: boolean;
    code: boolean;
    color: 'default';
  };
}

/** A block request: `{ object: 'block', type, [type]: payload }`. */
export type NotionBlock = { object: 'block'; type: string } & Record<string, unknown>;

const MAX_TEXT = 2000;
const LANGUAGES = new Map(
  Object.entries({
    js: 'javascript',
    javascript: 'javascript',
    ts: 'typescript',
    typescript: 'typescript',
    json: 'json',
    py: 'python',
    python: 'python',
    go: 'go',
    java: 'java',
    kotlin: 'kotlin',
    sh: 'shell',
    bash: 'bash',
    shell: 'shell',
    sql: 'sql',
    yaml: 'yaml',
    yml: 'yaml',
    md: 'markdown',
    markdown: 'markdown',
    html: 'html',
    css: 'css',
    xml: 'xml',
  }),
);

export function richText(inline: Inline[]): NotionRichText[] {
  const out: NotionRichText[] = [];
  const push = (content: string, run?: Extract<Inline, { type: 'text' }>) => {
    for (let i = 0; i < content.length; i += MAX_TEXT) {
      out.push({
        type: 'text',
        text: { content: content.slice(i, i + MAX_TEXT), link: run?.href ? { url: run.href } : null },
        annotations: {
          bold: run?.marks.includes('strong') ?? false,
          italic: run?.marks.includes('em') ?? false,
          strikethrough: run?.marks.includes('strike') ?? false,
          underline: false,
          code: run?.marks.includes('code') ?? false,
          color: 'default',
        },
      });
    }
  };
  for (const run of inline) {
    if (run.type === 'break') push('\n');
    else if (run.text) push(run.text, run);
  }
  return out;
}

export const plainRichText = (text: string): NotionRichText[] =>
  richText([{ type: 'text', text, marks: [] }]);

const block = (type: string, payload: Record<string, unknown>): NotionBlock => ({
  object: 'block',
  type,
  [type]: payload,
});

function blocksToNotion(blocks: Block[], depth: number, maxDepth: number): NotionBlock[] {
  return blocks.flatMap((b): NotionBlock[] => {
    switch (b.type) {
      case 'heading':
        return [block(`heading_${Math.min(3, b.level)}`, { rich_text: richText(b.inline) })];
      case 'paragraph':
        return [block('paragraph', { rich_text: richText(b.inline) })];
      case 'code':
        return [
          block('code', {
            rich_text: plainRichText(b.text),
            language: LANGUAGES.get(b.lang.toLowerCase()) ?? 'plain text',
          }),
        ];
      case 'quote': {
        const [first, ...rest] = b.blocks;
        const inline = first?.type === 'paragraph' || first?.type === 'heading' ? first.inline : [];
        const others = first?.type === 'paragraph' || first?.type === 'heading' ? rest : b.blocks;
        return [withChildren(block('quote', { rich_text: richText(inline) }), others, depth, maxDepth)];
      }
      case 'rule':
        return [block('divider', {})];
      case 'table': {
        const width = Math.max(1, b.header.length);
        const row = (cells: Inline[][]) =>
          block('table_row', { cells: Array.from({ length: width }, (_, i) => richText(cells[i] ?? [])) });
        if (depth >= maxDepth) {
          return [b.header, ...b.rows].map((cells) =>
            block('paragraph', { rich_text: plainRichText(cells.map(inlineText).join(' | ')) }),
          );
        }
        return [
          block('table', {
            table_width: width,
            has_column_header: true,
            has_row_header: false,
            children: [row(b.header), ...b.rows.map(row)],
          }),
        ];
      }
      case 'list':
        return b.items.flatMap((it, idx) => {
          const [first, ...rest] = it.blocks;
          const inline = first?.type === 'paragraph' || first?.type === 'heading' ? first.inline : [];
          const others = first?.type === 'paragraph' || first?.type === 'heading' ? rest : it.blocks;
          const type =
            it.checked !== null ? 'to_do' : b.ordered ? 'numbered_list_item' : 'bulleted_list_item';
          const payload: Record<string, unknown> = { rich_text: richText(inline) };
          if (it.checked !== null) payload.checked = it.checked;
          if (b.ordered && idx === 0 && b.start !== 1) payload.list_start_index = b.start;
          if (depth >= maxDepth) {
            // Too deep for one request: keep the content as following siblings.
            return [block(type, payload), ...blocksToNotion(others, depth, maxDepth)];
          }
          return [withChildren(block(type, payload), others, depth, maxDepth)];
        });
    }
    return [];
  });
}

function withChildren(parent: NotionBlock, children: Block[], depth: number, maxDepth: number): NotionBlock {
  if (children.length === 0) return parent;
  const payload = parent[parent.type] as Record<string, unknown>;
  payload.children = blocksToNotion(children, depth + 1, maxDepth);
  return parent;
}

/**
 * Markdown → Notion block requests. `maxDepth` is how many levels of children the result may
 * carry (2 at page level, 1 inside a container block). Deterministic.
 */
export function markdownToNotion(markdown: string, maxDepth = 2): NotionBlock[] {
  return blocksToNotion(parseMarkdown(markdown), 1, maxDepth);
}
