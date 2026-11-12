/** Small Markdown emit helpers shared by the ADF and Notion converters. Owner: qa-work-session-a. */

/** Wraps `text` in `mark` while keeping surrounding whitespace outside (`**a **` is not bold). */
export function wrapInline(text: string, mark: string, closing = mark): string {
  const m = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
  const [lead = '', core = '', trail = ''] = m ? m.slice(1) : [];
  return core ? `${lead}${mark}${core}${closing}${trail}` : text;
}

/** Inline code span that survives backticks in the content. */
export function codeSpan(text: string): string {
  return text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``;
}

/** Prefixes the first line with `marker` and indents the rest to line up under it. */
export function hang(text: string, marker: string): string {
  const pad = ' '.repeat(marker.length);
  return text
    .split('\n')
    .map((l, i) => (i === 0 ? `${marker}${l}` : l ? `${pad}${l}` : l))
    .join('\n');
}

/** Prefixes every line with `> `. */
export function quote(text: string): string {
  return text
    .split('\n')
    .map((l) => (l ? `> ${l}` : '>'))
    .join('\n');
}

/** Fenced code block whose fence is longer than any backtick run in `code`. */
export function fencedCode(code: string, language: string): string {
  const longest = Math.max(2, ...[...code.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${language}\n${code}\n${fence}`;
}

/** GFM table; the first row is the header. Cells are flattened to one line and `|`-escaped. */
export function markdownTable(rows: string[][]): string {
  if (rows.length === 0) return '';
  const width = Math.max(1, ...rows.map((r) => r.length));
  const clean = (c: string) => c.replace(/\n+/g, '<br>').replace(/\|/g, '\\|').trim();
  const line = (r: string[]) =>
    `| ${[...r, ...Array<string>(width - r.length).fill('')].map(clean).join(' | ')} |`;
  const [head = [], ...rest] = rows;
  return [line(head), `|${' --- |'.repeat(width)}`, ...rest.map(line)].join('\n');
}

/** Collapses 3+ newlines and trims. */
export function tidy(markdown: string): string {
  return markdown.replace(/\n{3,}/g, '\n\n').trim();
}
