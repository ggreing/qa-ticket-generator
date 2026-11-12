/** Atlassian Document Format → Markdown (PRD-04). Owner: qa-work-session-a. */
import { codeSpan, fencedCode, hang, markdownTable, quote, tidy, wrapInline } from './md';

/** Loose ADF node; input comes from an external API, so every field is treated as optional. */
export interface AdfNode {
  type?: unknown;
  text?: unknown;
  attrs?: Record<string, unknown>;
  marks?: { type?: unknown; attrs?: Record<string, unknown> }[];
  content?: unknown;
}

const MAX_DEPTH = 40;

const isNode = (v: unknown): v is AdfNode => typeof v === 'object' && v !== null && !Array.isArray(v);
const children = (node: AdfNode): AdfNode[] =>
  Array.isArray(node.content) ? node.content.filter(isNode) : [];
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

function applyMarks(text: string, node: AdfNode): string {
  if (!text) return text;
  const marks = Array.isArray(node.marks) ? node.marks : [];
  const has = (t: string) => marks.some((m) => m?.type === t);
  let out = text;
  if (has('code')) out = codeSpan(out);
  if (has('strike')) out = wrapInline(out, '~~');
  if (has('em')) out = wrapInline(out, '_');
  if (has('strong')) out = wrapInline(out, '**');
  const link = marks.find((m) => m?.type === 'link');
  const href = str(link?.attrs?.href);
  if (href) out = wrapInline(out, '[', `](${href})`);
  return out;
}

function inline(nodes: AdfNode[], depth: number): string {
  let out = '';
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out += applyMarks(str(node.text), node);
        break;
      case 'hardBreak':
        out += '\n';
        break;
      case 'mention': {
        const name = str(node.attrs?.text) || str(node.attrs?.id);
        out += name.startsWith('@') ? name : `@${name}`;
        break;
      }
      case 'inlineCard':
      case 'blockCard':
      case 'embedCard':
        out += str(node.attrs?.url);
        break;
      case 'emoji':
        out += str(node.attrs?.text) || str(node.attrs?.shortName);
        break;
      case 'status':
        out += `[${str(node.attrs?.text)}]`;
        break;
      case 'date': {
        const ts = Number(node.attrs?.timestamp);
        out += Number.isFinite(ts) ? new Date(ts).toISOString().slice(0, 10) : '';
        break;
      }
      default:
        if (depth < MAX_DEPTH) out += inline(children(node), depth + 1);
    }
  }
  return out;
}

function listItem(node: AdfNode, marker: string, depth: number): string {
  const body = blocks(children(node), depth + 1, '\n');
  return hang(body, marker);
}

function taskItems(list: AdfNode, depth: number): string {
  return children(list)
    .map((item) => {
      if (item.type === 'taskList') return hang(taskItems(item, depth + 1), '  ');
      const box = item.attrs?.state === 'DONE' ? '[x]' : '[ ]';
      return hang(inline(children(item), depth + 1), `- ${box} `);
    })
    .join('\n');
}

function cell(node: AdfNode, depth: number): string {
  return blocks(children(node), depth + 1, '\n');
}

function table(node: AdfNode, depth: number): string {
  const rows = children(node)
    .filter((r) => r.type === 'tableRow')
    .map((r) => children(r).map((c) => cell(c, depth + 1)));
  return markdownTable(rows);
}

function codeBlock(node: AdfNode): string {
  const code = children(node)
    .map((c) => str(c.text))
    .join('');
  return fencedCode(code, str(node.attrs?.language));
}

function block(node: AdfNode, depth: number): string {
  if (depth > MAX_DEPTH) return '';
  switch (node.type) {
    case 'paragraph':
      return inline(children(node), depth);
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level) || 1));
      return `${'#'.repeat(level)} ${inline(children(node), depth).replace(/\n/g, ' ')}`;
    }
    case 'bulletList':
      return children(node)
        .map((item) => listItem(item, '- ', depth))
        .join('\n');
    case 'orderedList': {
      const start = Number(node.attrs?.order) || 1;
      return children(node)
        .map((item, i) => listItem(item, `${start + i}. `, depth))
        .join('\n');
    }
    case 'listItem':
      return listItem(node, '- ', depth);
    case 'taskList':
      return taskItems(node, depth);
    case 'taskItem':
      return taskItems({ content: [node] }, depth);
    case 'codeBlock':
      return codeBlock(node);
    case 'blockquote':
    case 'panel':
      return quote(blocks(children(node), depth + 1));
    case 'expand':
    case 'nestedExpand': {
      const title = str(node.attrs?.title);
      const body = blocks(children(node), depth + 1);
      return title ? `**${title}**\n\n${body}` : body;
    }
    case 'table':
      return table(node, depth);
    case 'rule':
      return '---';
    case 'mediaSingle':
    case 'mediaGroup':
    case 'media':
      return '';
    case 'text':
    case 'hardBreak':
    case 'mention':
    case 'inlineCard':
    case 'blockCard':
    case 'embedCard':
    case 'emoji':
    case 'status':
    case 'date':
      return inline([node], depth);
    default:
      // Unknown containers (e.g. layoutSection/layoutColumn): keep their content.
      return blocks(children(node), depth + 1);
  }
}

function blocks(nodes: AdfNode[], depth: number, sep = '\n\n'): string {
  return nodes
    .map((n) => block(n, depth))
    .filter((s) => s.trim() !== '')
    .join(sep);
}

/**
 * Converts an ADF document (Jira Cloud REST v3 rich text) to Markdown.
 *
 * Supported: paragraph, heading, bulletList/orderedList/listItem, taskList/taskItem, codeBlock,
 * blockquote, table, hardBreak, mention, inlineCard and the strong/em/code/link (+strike) marks;
 * panel/expand/rule/emoji/status/date are rendered approximately, media is dropped and unknown
 * containers keep their children. Non-ADF input yields ''.
 *
 * @param adf An ADF `doc` node (or any ADF node).
 */
export function adfToMarkdown(adf: unknown): string {
  if (!isNode(adf)) return '';
  return tidy(adf.type === 'doc' ? blocks(children(adf), 0) : block(adf, 0));
}
