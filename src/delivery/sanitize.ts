/**
 * Output sanitization (DLV-06, SPEC §11). Model output and PR/PRD text are data: nothing in them
 * may become markup, a mention, or a link to somewhere we did not vouch for.
 *
 * Markdown strategy. The same sanitized string has to be safe in two places: ordinary inline
 * Markdown, and the `<summary>` line of a `<details>` block, which GitHub treats as raw HTML
 * (Markdown escapes are not processed there). So nothing here relies on Markdown syntax:
 * - every untrusted string is flattened to one line, so it cannot open a block construct;
 * - `<`, `>`, `&` become entities, so it cannot become HTML, a hidden comment or a forged marker;
 * - Markdown-significant characters become numeric entities, which are inert in both places;
 * - backtick code spans are re-emitted as `<code>` elements with encoded content;
 * - links survive only when allow-listed, as `<a>` elements; images never do; anything else that
 *   looks like a URL, e-mail address or @mention gets a zero-width space so no renderer links it.
 * The result is safe even where this tokenizer and GitHub's parser disagree about code spans.
 * Owner: qa-work-session-c(fable).
 */
import type { FinalReport } from '../core/contracts';

/** URL prefixes that links may point to (DLV-06). */
export interface LinkPolicy {
  /** Lower-cased `host/path` prefixes without scheme, e.g. `github.com/acme/shop`. */
  allowed: string[];
}

const ZWSP = '\u200b';
const SLACK_TILDE = '\u223c';
// Control characters, zero-width characters and bidi overrides (text-direction spoofing).
const INVISIBLE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point.
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁠-⁩﻿]/g;
const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>()[\]"'`|]+/gi;
const MD_LINK = /(!?)\[([^\]]*)\]\(\s*<?([^)\s>]*)>?[^)]*\)/g;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

const TEXT_ENTITIES: Readonly<Record<string, string>> = {
  '[': '&#91;',
  ']': '&#93;',
  '|': '&#124;',
  '`': '&#96;',
  '\\': '&#92;',
  // GitHub strikes through everything between two tildes, and "1~2초, 3~5회" has two.
  '~': '&#126;',
};
const CODE_ENTITIES: Readonly<Record<string, string>> = {
  ...TEXT_ENTITIES,
  '*': '&#42;',
  _: '&#95;',
};

function prefixOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    return `${u.host}${u.pathname}`.toLowerCase().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** DLV-06 — links may point at the PR's repository and at the linked PRD documents, nothing else. */
export function linkPolicyFor(final: Pick<FinalReport, 'pr' | 'meta'>): LinkPolicy {
  const allowed: string[] = [];
  const pr = prefixOf(final.pr.htmlUrl);
  if (pr) {
    const host = pr.split('/')[0] as string;
    allowed.push(`${host}/${final.pr.owner}/${final.pr.repo}`.toLowerCase());
  }
  for (const ref of final.meta.prdSources) {
    const prefix = ref.url ? prefixOf(ref.url) : null;
    if (prefix) allowed.push(prefix);
  }
  return { allowed };
}

/** True for https URLs under an allowed prefix (same host, same path or a sub-path). */
export function isAllowedUrl(url: string, policy: LinkPolicy): boolean {
  const target = prefixOf(url);
  if (target === null) return false;
  return policy.allowed.some((prefix) => target === prefix || target.startsWith(`${prefix}/`));
}

/** Collapses whitespace to single spaces and drops invisible/bidi characters. */
export function flatten(text: string): string {
  return text.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
}

/** Cuts `text` to at most `max` characters, ending with an ellipsis when shortened. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Breaks URL and e-mail shapes with a zero-width space so no renderer turns them into links. */
function unlink(text: string): string {
  return text
    .replace(/:\/\//g, `:${ZWSP}//`)
    .replace(/\bwww\./gi, (m) => `${m.slice(0, 3)}${ZWSP}.`)
    .replace(/(?<=[\w.+-])@(?=[\w-]+\.)/g, `@${ZWSP}`);
}

/** Renders text as an inline `<code>` element; the content is inert (no HTML, Markdown or links). */
export function mdCode(text: string): string {
  const inner = escapeHtml(unlink(flatten(text))).replace(/[[\]|`\\*_~]/g, (ch) => CODE_ENTITIES[ch] ?? ch);
  return `<code>${inner}</code>`;
}

function encodeText(text: string): string {
  return escapeHtml(text).replace(/[[\]|`\\~]/g, (ch) => TEXT_ENTITIES[ch] ?? ch);
}

function mdText(text: string): string {
  return encodeText(text).replace(/@(?=[\w-])/g, `@${ZWSP}`); // no @user / @org/team notifications
}

function mdPlain(text: string, policy: LinkPolicy): string {
  let out = '';
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const raw = match[0];
    const trailing = raw.match(TRAILING_PUNCTUATION)?.[0] ?? '';
    const url = trailing ? raw.slice(0, -trailing.length) : raw;
    out += mdText(text.slice(last, match.index));
    out += isAllowedUrl(url, policy) ? encodeText(url) : mdCode(url);
    out += mdText(trailing);
    last = match.index + raw.length;
  }
  return out + mdText(text.slice(last));
}

function mdLinks(text: string, policy: LinkPolicy): string {
  let out = '';
  let last = 0;
  for (const match of text.matchAll(MD_LINK)) {
    const [whole, bang, label = '', url = ''] = match;
    out += mdPlain(text.slice(last, match.index), policy);
    // Images are never embedded (tracking pixels); links survive only when allow-listed.
    out +=
      bang === '' && isAllowedUrl(url, policy)
        ? `<a href="${escapeHtml(url).replace(/"/g, '&quot;')}">${mdText(unlink(label))}</a>`
        : mdPlain(label, policy);
    last = match.index + whole.length;
  }
  return out + mdPlain(text.slice(last), policy);
}

/**
 * DLV-06 — makes untrusted text safe to place inline in a GitHub comment (Markdown or raw-HTML
 * context): single line, HTML escaped, links allow-listed, images dropped, mentions and
 * Markdown syntax neutralized. Backtick code spans keep their look as inert `<code>` elements.
 */
export function mdInline(text: string, policy: LinkPolicy): string {
  const flat = flatten(text);
  let out = '';
  let last = 0;
  // A code span sits between two backtick runs of equal length (maximal runs, as in CommonMark).
  for (const match of flat.matchAll(/(?<!`)(`+)(?!`)(.+?)(?<!`)\1(?!`)/g)) {
    out += mdLinks(flat.slice(last, match.index), policy);
    out += mdCode(match[2] ?? '');
    last = match.index + match[0].length;
  }
  return out + mdLinks(flat.slice(last), policy);
}

/**
 * DLV-06 — makes untrusted text safe for Slack mrkdwn: `&`, `<`, `>` escaped (which disarms
 * `<!channel>`, `<@U…>` and `<url|label>`), `@channel`/`@here`/`@everyone` broken up, URLs
 * outside the allow-list defanged so Slack does not turn them into links, and `~` replaced so
 * a range such as "1~2s, 3~5 times" is not struck through.
 */
export function slackText(text: string, policy: LinkPolicy): string {
  // Slack strikes through `~text~` and has no escape for it, so prose gets the look-alike
  // tilde operator (U+223C) instead of the ASCII tilde.
  return slackCodeText(text, policy).replace(/~/g, SLACK_TILDE);
}

/**
 * Like {@link slackText} but keeps `~` as typed. For text placed inside a backtick code span,
 * where Slack applies no formatting and the exact characters matter.
 */
export function slackCodeText(text: string, policy: LinkPolicy): string {
  return flatten(text)
    .replace(URL_PATTERN, (raw) => {
      const trailing = raw.match(TRAILING_PUNCTUATION)?.[0] ?? '';
      const url = trailing ? raw.slice(0, -trailing.length) : raw;
      if (isAllowedUrl(url, policy)) return raw;
      return `${url.replace(/^http/i, 'hxxp').replace(/^www\./i, 'www[.]')}${trailing}`;
    })
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/@(?=(?:channel|here|everyone)\b)/gi, `@${ZWSP}`);
}
