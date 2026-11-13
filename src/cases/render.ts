/**
 * §3.1 — renders a case for sinks: a labelled title, a Markdown body, a flat field map and the hash
 * of the tool-owned text (§4.5). Pure.
 *
 * Markdown subset (agreed with the sinks, which convert it to ADF / Notion blocks):
 * `### ` headings, `- ` bullets, `1. ` numbered items, paragraphs, `**bold**`, single-backtick code
 * spans and backslash escapes. No links, tables, HTML, images or nesting. Untrusted text is escaped
 * so it cannot become markup, a hidden comment, a mention, an issue reference or a strikethrough.
 */
import { createHash } from 'node:crypto';
import type { QaCase, RenderedCase } from '../core/cases';
import type { Language } from '../core/contracts';
import { CODE_STATUS_LABELS, OBSOLETE_LABEL, SECTION_LABELS, TECHNIQUE_LABELS } from './labels';

/** Jira summaries hold 255 characters, GitHub titles 256. */
export const MAX_TITLE_LENGTH = 250;

// Control characters, zero-width characters and bidi overrides.
const INVISIBLE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point.
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

/** One line: invisible characters dropped, whitespace collapsed. */
export function flattenLine(text: string): string {
  return text.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
}

const MD_SPECIAL = /[\\`*_[\]<>#|~&]/g;
/** Tokens that GitHub would turn into links, notifications or cross-references. */
const LINKISH =
  /(?:https?:\/\/|www\.)[^\s`]+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|(?<![\w`])@[A-Za-z0-9][\w-]*(?:\/[\w.-]+)?|(?<![\w`&])#\d+\b|\b[\w.-]+\/[\w.-]+#\d+\b/g;

function escapeText(text: string): string {
  return text.replace(MD_SPECIAL, (ch) => `\\${ch}`);
}

function codeSpan(text: string): string {
  // A code span cannot contain a backtick in this subset; the rest is literal inside it.
  return `\`${text.replace(/`/g, "'")}\``;
}

function escapeLinkish(text: string): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(LINKISH)) {
    // Sentence punctuation after a URL is not part of it ("see https://x.example/a).").
    const trailing = /[).,;:!?\]]+$/.exec(m[0])?.[0] ?? '';
    const token = trailing ? m[0].slice(0, -trailing.length) : m[0];
    out += escapeText(text.slice(last, m.index));
    out += token ? codeSpan(token) + escapeText(trailing) : escapeText(m[0]);
    last = m.index + m[0].length;
  }
  return out + escapeText(text.slice(last));
}

/**
 * Untrusted text as one safe inline Markdown string. Single-backtick spans the model wrote stay
 * code spans; everything else is escaped, and link-like tokens become code spans.
 */
export function mdSafe(text: string): string {
  const flat = flattenLine(text);
  let out = '';
  let last = 0;
  for (const m of flat.matchAll(/`([^`]+)`/g)) {
    out += escapeLinkish(flat.slice(last, m.index));
    out += codeSpan(m[1] as string);
    last = m.index + m[0].length;
  }
  out += escapeLinkish(flat.slice(last));
  // A line that starts like a list item or is a rule would open a block: escape its marker.
  if (/^[-=+]{3,}$/.test(out)) return `\\${out}`;
  if (/^[-+]\s/.test(out)) return `\\${out}`;
  return out.replace(/^(\d+)([.)])(\s)/, '$1\\$2$3');
}

/** Leading `[P0]` / `[경계값]`-style labels the model may have put into the title. */
const LEADING_LABELS = /^(?:\s*[[［【][^\]］】]{1,20}[\]］】])+\s*/;
/** `1. `, `1) `, `- ` at the start of a step (the renderer numbers steps itself). */
const LEADING_NUMBER = /^\s*(?:\d+[.)]|[-*•])\s+/;

export function plainTitle(title: string): string {
  // HTML comments never belong in a title (and could imitate a qtg-case marker).
  return flattenLine(title.replace(/<!--[\s\S]*?(?:-->|$)/g, ' '))
    .replace(LEADING_LABELS, '')
    .trim();
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/** `[P0][경계값] 만료 1초 지난 쿠폰 적용 시 거부`, with `[해당 없음]` first when obsolete. */
export function renderTitle(c: QaCase, language: Language): string {
  const prefix = c.lifecycle === 'obsolete' ? `[${OBSOLETE_LABEL[language]}]` : '';
  const head = `${prefix}[${c.priority}][${TECHNIQUE_LABELS[language][c.technique]}] `;
  return head + truncate(plainTitle(c.title), MAX_TITLE_LENGTH - head.length);
}

function stepText(step: string): string {
  return flattenLine(step).replace(LEADING_NUMBER, '');
}

const bullets = (items: string[]): string[] => items.map((x) => `- ${mdSafe(x)}`);

/** The Markdown body (no hidden markers; sinks add those). */
export function renderMarkdown(c: QaCase, language: Language): string {
  const L = SECTION_LABELS[language];
  const blocks: string[] = [];
  const section = (heading: string, lines: string[]) => {
    if (lines.length > 0) blocks.push(`### ${heading}`, lines.join('\n'));
  };

  section(L.preconditions, bullets(c.preconditions));
  section(L.testData, bullets(c.testData));
  section(
    L.steps,
    c.steps.map((s, i) => `${i + 1}. ${mdSafe(stepText(s))}`),
  );
  section(
    L.expected,
    c.expected.map((e, i) => (i === 0 ? `- **${mdSafe(e)}**` : `- ${mdSafe(e)}`)),
  );
  if (c.whyEasyToMiss.trim() !== '') section(L.whyEasyToMiss, [mdSafe(c.whyEasyToMiss)]);
  const files = c.codeStatus?.files ?? [];
  if (c.acLabels.length > 0) section(L.acLabels, [c.acLabels.map(mdSafe).join(', ')]);
  else if (c.origin === 'code') section(L.acLabels, [L.codeOrigin]);
  if (c.codeStatus) {
    const s = c.codeStatus;
    const sha = s.sha ? ` (${codeSpan(s.sha.slice(0, 7))})` : '';
    const lines = [`**${CODE_STATUS_LABELS[language][s.status]}**${sha}`];
    if (s.evidence.trim() !== '') lines.push('', mdSafe(s.evidence));
    if (files.length > 0) lines.push('', ...files.map((f) => `- ${codeSpan(flattenLine(f))}`));
    section(L.codeStatus, lines);
  }
  return blocks.join('\n\n');
}

/** Flat, unescaped field map for structured sinks (Notion properties, CSV columns). */
export function renderFields(c: QaCase, language: Language, title: string): Record<string, string> {
  const s = c.codeStatus;
  return {
    case_id: c.caseId,
    spec_ref: c.specRef,
    title,
    name: plainTitle(c.title),
    priority: c.priority,
    technique: c.technique,
    technique_label: TECHNIQUE_LABELS[language][c.technique],
    ac: c.acLabels.join(', '),
    preconditions: c.preconditions.map(flattenLine).join('\n'),
    test_data: c.testData.map(flattenLine).join('\n'),
    steps: c.steps.map((x, i) => `${i + 1}. ${stepText(x)}`).join('\n'),
    expected: c.expected.map(flattenLine).join('\n'),
    why_easy_to_miss: flattenLine(c.whyEasyToMiss),
    origin: c.origin,
    lifecycle: c.lifecycle,
    code_status: s?.status ?? '',
    code_status_label: s ? CODE_STATUS_LABELS[language][s.status] : '',
    code_evidence: s ? flattenLine(s.evidence) : '',
    code_files: s ? s.files.map(flattenLine).join(', ') : '',
    code_sha: s?.sha ?? '',
  };
}

/** §4.5 — sha256 (hex) of the tool-owned text: rendered title and Markdown body. */
export function toolTextHash(title: string, markdown: string): string {
  const norm = (s: string) => s.replace(/\r\n?/g, '\n');
  return createHash('sha256')
    .update(`${norm(title)}\n${norm(markdown)}`)
    .digest('hex');
}

/** §3.1 — everything a sink needs to write one case. */
export function renderCase(c: QaCase, language: Language): RenderedCase {
  const title = renderTitle(c, language);
  const markdown = renderMarkdown(c, language);
  return { title, markdown, fields: renderFields(c, language, title), hash: toolTextHash(title, markdown) };
}
