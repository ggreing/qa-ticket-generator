/** Acceptance-criteria extraction from Markdown (PRD-07). Owner: qa-work-session-a. */

interface Line {
  indent: number;
  text: string;
}

const ATX_HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST_ITEM = /^(\s*)(?:[-*+]|\d{1,9}[.)])\s+(.*)$/;
const CHECKBOX = /^\[([ xX])\]\s+/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** "Acceptance Criteria", "인수 조건", "AC" (but not "ACL"/"Accessibility"), optionally numbered or emoji-prefixed. */
const AC_TITLE = /^(?:acceptance\s+criteria|인수\s*조건|acs?)(?![\p{L}\p{N}])/iu;
/** Pseudo-headings: a line that is only bold text, or "Acceptance Criteria:". */
const BOLD_LINE = /^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*:?\s*$/;
const COLON_LINE = /^\s*(.+?)\s*:\s*$/;

function stripDecorations(title: string): string {
  return title
    .replace(/[*_`]/g, '')
    .replace(/^[^\p{L}]+/u, '')
    .trim();
}

const isAcTitle = (title: string): boolean => AC_TITLE.test(stripDecorations(title));

/** Heading level, with pseudo-headings ranked below every ATX heading (7). */
function headingOf(line: string): { level: number; title: string } | null {
  const atx = line.match(ATX_HEADING);
  if (atx?.[1]) return { level: atx[1].length, title: atx[2] ?? '' };
  const bold = line.match(BOLD_LINE);
  if (bold?.[1]) return { level: 7, title: bold[1] };
  const colon = line.match(COLON_LINE);
  if (colon?.[1] && !LIST_ITEM.test(line) && isAcTitle(colon[1])) return { level: 7, title: colon[1] };
  return null;
}

/** Lines outside fenced code blocks, tabs expanded. */
function contentLines(markdown: string): string[] {
  const out: string[] = [];
  let fence: string | null = null;
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.replace(/\t/g, '    ');
    const f = line.match(FENCE)?.[1];
    if (fence) {
      if (f && f[0] === fence[0] && f.length >= fence.length && line.trim() === f) fence = null;
      continue;
    }
    if (f) {
      fence = f;
      continue;
    }
    out.push(line);
  }
  return out;
}

function cleanItem(text: string): string {
  return text.replace(CHECKBOX, '').replace(/\s+/g, ' ').trim();
}

/**
 * Collects list items from `lines`. Nested items and continuation lines are folded into their
 * top-level item ("parent; child") so each entry stays one self-contained criterion.
 */
function collectItems(lines: string[], onlyCheckboxes: boolean): string[] {
  const items: string[] = [];
  let current: { indent: number; parts: string[] } | null = null;
  const flush = () => {
    if (current) {
      const text = current.parts.filter(Boolean).join('; ');
      if (text) items.push(text);
    }
    current = null;
  };

  for (const raw of lines) {
    if (raw.trim() === '') continue;
    const m = raw.match(LIST_ITEM);
    const line: Line | null = m ? { indent: m[1]?.length ?? 0, text: m[2] ?? '' } : null;
    if (line && (!onlyCheckboxes || CHECKBOX.test(line.text) || (current && line.indent > current.indent))) {
      if (current && line.indent > current.indent) {
        current.parts.push(cleanItem(line.text));
      } else {
        flush();
        current = { indent: line.indent, parts: [cleanItem(line.text)] };
      }
      continue;
    }
    const indent = raw.length - raw.trimStart().length;
    if (current && !line && indent > current.indent) {
      // Lazy continuation of the current item's text.
      const last = current.parts.length - 1;
      current.parts[last] = `${current.parts[last]} ${raw.trim()}`.trim();
      continue;
    }
    flush();
  }
  flush();
  return items;
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

/**
 * Every list item in `markdown` (used when a whole field is the acceptance criteria, e.g. a Jira
 * custom field). Falls back to non-empty lines when the text has no list at all.
 */
export function extractListItems(markdown: string): string[] {
  const lines = contentLines(markdown);
  const items = collectItems(lines, false);
  if (items.length > 0) return dedupe(items);
  return dedupe(lines.map((l) => cleanItem(l.replace(ATX_HEADING, '$2'))).filter(Boolean));
}

/**
 * PRD-07 — extracts acceptance criteria from a PRD body:
 * 1. list items under a heading named "Acceptance Criteria", "인수 조건" or "AC" (any level, also a
 *    bold-only or "Acceptance Criteria:" line), up to the next heading of the same or higher level;
 * 2. otherwise every checkbox item (`- [ ]`, `- [x]`) in the document;
 * 3. otherwise an empty array — the LLM then reads the criteria from the body.
 *
 * Code blocks are ignored; checkbox markers are removed; nested items fold into their parent.
 */
export function extractAcceptanceCriteria(markdown: string): string[] {
  if (!markdown.trim()) return [];
  const lines = contentLines(markdown);
  const sections: string[][] = [];
  let section: { level: number; lines: string[] } | null = null;

  for (const line of lines) {
    const heading = headingOf(line);
    if (heading) {
      if (section && heading.level <= section.level) {
        sections.push(section.lines);
        section = null;
      }
      if (!section && isAcTitle(heading.title)) {
        section = { level: heading.level, lines: [] };
        continue;
      }
    }
    section?.lines.push(line);
  }
  if (section) sections.push(section.lines);

  const fromHeadings = sections.flatMap((s) => collectItems(s, false));
  if (fromHeadings.length > 0) return dedupe(fromHeadings);
  return dedupe(collectItems(lines, true));
}
