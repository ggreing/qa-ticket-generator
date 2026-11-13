/**
 * Minimal Markdown parser for case bodies (GitHub-flavoured subset), shared by the
 * Markdown→ADF (Jira) and Markdown→Notion-blocks emitters. Owner: qa-work-session-a.
 *
 * Blocks: ATX headings, paragraphs (single newlines are hard breaks, as GitHub renders issue
 * bodies), bullet / ordered / task lists with nesting, fenced code, blockquotes, GFM tables and
 * horizontal rules. Inline: **strong**, *em* / _em_, ~~strike~~, `code`, [text](url), <url>,
 * backslash escapes. Anything else stays literal text.
 */

export type Mark = 'strong' | 'em' | 'code' | 'strike';

export type Inline = { type: 'text'; text: string; marks: Mark[]; href?: string } | { type: 'break' };

export interface ListItem {
  /** null for a plain item, true/false for a task item. */
  checked: boolean | null;
  blocks: Block[];
}

export type Block =
  | { type: 'heading'; level: number; inline: Inline[] }
  | { type: 'paragraph'; inline: Inline[] }
  | { type: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'quote'; blocks: Block[] }
  | { type: 'table'; header: Inline[][]; rows: Inline[][][] }
  | { type: 'rule' };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

const indentOf = (line: string): number => line.length - line.trimStart().length;
const isBlank = (line: string): boolean => line.trim() === '';

function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i] ?? '';
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    LIST.test(line) ||
    /^\s*>/.test(line) ||
    (line.includes('|') && TABLE_SEP.test(lines[i + 1] ?? ''))
  );
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

/** Parses a Markdown document into blocks. */
export function parseMarkdown(markdown: string): Block[] {
  return parseLines(markdown.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n'));
}

function parseLines(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (isBlank(line)) {
      i++;
      continue;
    }
    const fence = line.match(FENCE);
    if (fence?.[1]) {
      const close = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] as string).trim().startsWith(close))
        body.push(lines[i++] as string);
      i++; // closing fence (or end of input)
      blocks.push({ type: 'code', lang: fence[2] ?? '', text: body.join('\n') });
      continue;
    }
    const heading = line.match(HEADING);
    if (heading?.[1]) {
      blocks.push({ type: 'heading', level: heading[1].length, inline: parseInline(heading[2] ?? '') });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ type: 'rule' });
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i] as string)) {
        inner.push((lines[i] as string).replace(/^\s*>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'quote', blocks: parseLines(inner) });
      continue;
    }
    if (line.includes('|') && TABLE_SEP.test(lines[i + 1] ?? '')) {
      const header = splitRow(line).map((cell) => parseInline(cell));
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && (lines[i] as string).includes('|') && !isBlank(lines[i] as string)) {
        rows.push(splitRow(lines[i] as string).map((cell) => parseInline(cell)));
        i++;
      }
      blocks.push({ type: 'table', header, rows });
      continue;
    }
    if (LIST.test(line)) {
      const parsed = parseList(lines, i);
      blocks.push(parsed.block);
      i = parsed.next;
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      !isBlank(lines[i] as string) &&
      (para.length === 0 || !startsBlock(lines, i))
    ) {
      para.push((lines[i] as string).trim());
      i++;
    }
    blocks.push({ type: 'paragraph', inline: joinLines(para) });
  }
  return blocks;
}

/** Lines of one paragraph → inline content with hard breaks between lines. */
function joinLines(lines: string[]): Inline[] {
  const out: Inline[] = [];
  lines.forEach((l, idx) => {
    if (idx > 0) out.push({ type: 'break' });
    out.push(...parseInline(l.replace(/(\\| {2,})$/, '')));
  });
  return out;
}

function parseList(lines: string[], start: number): { block: Block; next: number } {
  const first = (lines[start] as string).match(LIST) as RegExpMatchArray;
  const baseIndent = (first[1] ?? '').length;
  const ordered = /\d/.test(first[2] ?? '');
  const items: ListItem[] = [];
  let i = start;
  while (i < lines.length) {
    const m = (lines[i] as string).match(LIST);
    if (!m || (m[1] ?? '').length !== baseIndent || /\d/.test(m[2] ?? '') !== ordered) break;
    const contentIndent = baseIndent + (m[2] ?? '').length + 1;
    let text = m[3] ?? '';
    let checked: boolean | null = null;
    const task = text.match(/^\[([ xX])\]\s+(.*)$/);
    if (task) {
      checked = task[1] !== ' ';
      text = task[2] ?? '';
    }
    const body: string[] = [text];
    i++;
    while (i < lines.length) {
      const l = lines[i] as string;
      if (isBlank(l)) {
        // A blank line continues the item only when indented content follows.
        const nextLine = lines[i + 1];
        if (nextLine !== undefined && !isBlank(nextLine) && indentOf(nextLine) > baseIndent) {
          body.push('');
          i++;
          continue;
        }
        break;
      }
      if (indentOf(l) <= baseIndent) break;
      body.push(l.slice(Math.min(indentOf(l), contentIndent)));
      i++;
    }
    items.push({ checked, blocks: parseLines(body) });
  }
  return {
    block: { type: 'list', ordered, start: ordered ? Number.parseInt(first[2] ?? '1', 10) : 1, items },
    next: i,
  };
}

// ───────────────────────────── inline ─────────────────────────────

/** Session b escapes these, plus a leading `-`/`+`/`1.`/`---`/`===` marker (`\- `, `1\. `, `\===`). */
const ESCAPABLE = /[\\`*_{}[\]()#+\-.!|~<>&=]/;

/** Parses inline Markdown into text runs with marks. */
export function parseInline(src: string, marks: Mark[] = [], href?: string): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({ type: 'text', text: buf, marks, ...(href ? { href } : {}) });
    buf = '';
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;
    if (ch === '\\' && ESCAPABLE.test(src[i + 1] ?? '')) {
      buf += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === '`') {
      const run = src.slice(i).match(/^`+/)?.[0] ?? '`';
      const end = src.indexOf(run, i + run.length);
      if (end > 0) {
        flush();
        const code = src.slice(i + run.length, end).replace(/^ (.*) $/, '$1');
        out.push({
          type: 'text',
          text: code,
          marks: [...marks.filter((m) => m !== 'code'), 'code'],
          ...(href ? { href } : {}),
        });
        i = end + run.length;
        continue;
      }
    }
    if (ch === '[' && !href) {
      const link = src.slice(i).match(/^\[((?:\\.|[^\]\\])*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/);
      if (link?.[2]) {
        flush();
        out.push(...parseInline(link[1] ?? '', marks, link[2]));
        i += link[0].length;
        continue;
      }
    }
    if (ch === '<' && !href) {
      const auto = src.slice(i).match(/^<(https?:\/\/[^\s>]+)>/);
      if (auto?.[1]) {
        flush();
        out.push({ type: 'text', text: auto[1], marks, href: auto[1] });
        i += auto[0].length;
        continue;
      }
    }
    const delim = matchDelimiter(src, i);
    if (delim) {
      flush();
      out.push(...parseInline(delim.inner, [...marks, delim.mark], href));
      i = delim.end;
      continue;
    }
    buf += ch;
    i++;
  }
  flush();
  return mergeRuns(out);
}

function matchDelimiter(src: string, i: number): { mark: Mark; inner: string; end: number } | null {
  const candidates: [string, Mark][] = [
    ['**', 'strong'],
    ['__', 'strong'],
    ['~~', 'strike'],
    ['*', 'em'],
    ['_', 'em'],
  ];
  for (const [d, mark] of candidates) {
    if (!src.startsWith(d, i)) continue;
    const after = src[i + d.length];
    if (after === undefined || /\s/.test(after)) continue;
    if (d === '_' || d === '__') {
      const before = src[i - 1];
      if (before !== undefined && /[\p{L}\p{N}]/u.test(before)) continue; // snake_case is not emphasis
    }
    let j = i + d.length;
    while (j < src.length) {
      const close = src.indexOf(d, j);
      if (close < 0) break;
      const prev = src[close - 1] ?? '';
      const next = src[close + d.length];
      const singleOk = d.length === 2 || src[close + 1] !== d; // `*` must not be half of `**`
      const wordOk = !(d.startsWith('_') && next !== undefined && /[\p{L}\p{N}]/u.test(next));
      if (close > i + d.length && !/\s/.test(prev) && singleOk && wordOk) {
        return { mark, inner: src.slice(i + d.length, close), end: close + d.length };
      }
      j = close + d.length;
    }
  }
  return null;
}

function mergeRuns(runs: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const r of runs) {
    const last = out.at(-1);
    if (
      r.type === 'text' &&
      last?.type === 'text' &&
      last.href === r.href &&
      last.marks.length === r.marks.length &&
      last.marks.every((m) => r.marks.includes(m))
    ) {
      last.text += r.text;
    } else {
      out.push(r.type === 'text' ? { ...r, marks: [...r.marks] } : r);
    }
  }
  return out;
}

/** Plain text of inline runs (breaks become newlines). */
export function inlineText(inline: Inline[]): string {
  return inline.map((r) => (r.type === 'break' ? '\n' : r.text)).join('');
}
