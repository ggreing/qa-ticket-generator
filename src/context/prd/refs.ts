/** PRD reference extraction from the PR body (SPEC §4.4, PRD-01). Owner: qa-work-session-a. */
import type { ExtractPrdRefs, PrdRef } from '../../core/contracts';

interface Candidate {
  start: number;
  end: number;
  ref: PrdRef;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Blanks out fenced code blocks and HTML comments so example links in PR templates are not
 * picked up. Lines are kept (as empty strings) so the order of what remains is unchanged.
 * Unclosed fences and comments run to the end of the body, as in CommonMark.
 */
export function stripNonContent(body: string): string {
  const out: string[] = [];
  let fence: { char: string; len: number } | null = null;
  let inComment = false;

  for (const rawLine of body.split(/\r?\n/)) {
    let line = rawLine;
    if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (close?.[1] && close[1][0] === fence.char && close[1].length >= fence.len) fence = null;
      out.push('');
      continue;
    }
    if (inComment) {
      const endIdx = line.indexOf('-->');
      if (endIdx < 0) {
        out.push('');
        continue;
      }
      line = line.slice(endIdx + 3);
      inComment = false;
    }
    const open = line.match(FENCE_OPEN);
    if (open?.[1] && !(open[1][0] === '`' && line.slice(open[0].length).includes('`'))) {
      fence = { char: open[1][0] as string, len: open[1].length };
      out.push('');
      continue;
    }
    let kept = '';
    for (;;) {
      const startIdx = line.indexOf('<!--');
      if (startIdx < 0) {
        kept += line;
        break;
      }
      kept += `${line.slice(0, startIdx)} `;
      const endIdx = line.indexOf('-->', startIdx + 4);
      if (endIdx < 0) {
        inComment = true;
        break;
      }
      line = line.slice(endIdx + 3);
    }
    out.push(kept);
  }
  return out.join('\n');
}

const URL_END = String.raw`[^\s<>()\[\]"'\x60]*`;
const GITHUB_ISSUE_URL = /https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)\b/gi;
const GITHUB_CROSS_REPO = /(?<![\w/.@-])([A-Za-z0-9][\w-]*)\/([\w.-]+)#([1-9]\d*)\b/g;
const GITHUB_SHORT = /(?<![\w/#&])#([1-9]\d*)\b/g;
const JIRA_URL = new RegExp(String.raw`https?://([\w-]+)\.atlassian\.net/${URL_END}`, 'gi');
const JIRA_KEY = /(?<![\w-])([A-Za-z][A-Za-z0-9_]*)-(\d+)\b/g;
const NOTION_URL = new RegExp(
  String.raw`https?://(?:www\.)?notion\.so/${URL_END}|https?://[\w-]+\.notion\.site/${URL_END}`,
  'gi',
);
const ANY_URL = /https?:\/\/[^\s<>()[\]"'`]+/gi;
const NOTION_HEX = /(?<![0-9a-f])([0-9a-f]{32})(?![0-9a-f])/gi;
const NOTION_UUID =
  /(?<![0-9a-f])([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})(?![0-9a-f])/gi;

/** Trailing punctuation that ends a sentence rather than the URL. */
const trimUrl = (url: string): string => url.replace(/[.,;:!?*_~]+$/, '');

/** Last Notion page id in `text` (32-hex or dashed UUID), normalized to 32 lower-case hex. */
function lastNotionId(text: string): string | undefined {
  let found: { at: number; id: string } | undefined;
  for (const m of text.matchAll(NOTION_HEX)) {
    if (m[1] && (!found || m.index >= found.at)) found = { at: m.index, id: m[1] };
  }
  for (const m of text.matchAll(NOTION_UUID)) {
    if (!found || m.index >= found.at) found = { at: m.index, id: m.slice(1, 6).join('') };
  }
  return found?.id.toLowerCase();
}

/** Page id of a Notion URL: the `p=` peek parameter wins, otherwise the last id in the path. */
export function notionIdFromUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const peek = parsed.searchParams.get('p');
  return (peek ? lastNotionId(peek) : undefined) ?? lastNotionId(parsed.pathname);
}

/** Jira issue key of an atlassian.net URL: `/browse/KEY-1` or a board's `selectedIssue=KEY-1`. */
function jiraKeyFromUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const browse = parsed.pathname.match(/\/browse\/([A-Za-z][A-Za-z0-9_]*-\d+)(?:\/|$)/);
  const key = browse?.[1] ?? parsed.searchParams.get('selectedIssue') ?? undefined;
  return key && /^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(key) ? key.toUpperCase() : undefined;
}

function githubRef(owner: string, repo: string, num: string, raw: string): PrdRef {
  const n = String(Number(num));
  return {
    source: 'github',
    id: `${owner}/${repo}#${n}`,
    url: `https://github.com/${owner}/${repo}/issues/${n}`,
    raw,
  };
}

/**
 * PRD-01 — extracts PRD references from a PR body (SPEC §4.4).
 *
 * - GitHub: `#123`, `owner/repo#123`, `https://github.com/o/r/issues/123` (closing keywords such as
 *   `Closes #12` are covered by the same patterns). `/pull/` URLs are not PRDs and are ignored.
 * - Jira: any `https://<site>.atlassian.net/browse/KEY-1` URL; a bare `KEY-1` only when `KEY` is in
 *   `jiraProjectKeys` (so `UTF-8` is not a ticket).
 * - Notion: `notion.so` / `*.notion.site` URLs with a 32-hex or dashed-UUID page id.
 *
 * Fenced code blocks and HTML comments are ignored. Results are de-duplicated, keep the order of
 * first appearance and are capped at `maxDocuments`.
 */
export const extractPrdRefs: ExtractPrdRefs = (body, options) => {
  if (options.maxDocuments <= 0 || !body) return [];
  const text = stripNonContent(body);
  const projectKeys = new Set(options.jiraProjectKeys.map((k) => k.trim().toUpperCase()));
  const linked: Candidate[] = [];
  const bare: Candidate[] = [];
  const add = (list: Candidate[], start: number, raw: string, ref: PrdRef) =>
    list.push({ start, end: start + raw.length, ref });

  for (const m of text.matchAll(GITHUB_ISSUE_URL)) {
    const [raw, owner, repo, num] = m;
    if (owner && repo && num) add(linked, m.index, raw, githubRef(owner, repo, num, raw));
  }
  for (const m of text.matchAll(JIRA_URL)) {
    const raw = trimUrl(m[0]);
    const key = jiraKeyFromUrl(raw);
    if (key) add(linked, m.index, raw, { source: 'jira', id: key, url: raw, raw });
  }
  for (const m of text.matchAll(NOTION_URL)) {
    const raw = trimUrl(m[0]);
    const id = notionIdFromUrl(raw);
    if (id) add(linked, m.index, raw, { source: 'notion', id, url: raw, raw });
  }

  for (const m of text.matchAll(GITHUB_CROSS_REPO)) {
    const [raw, owner, repo, num] = m;
    if (owner && repo && num) add(bare, m.index, raw, githubRef(owner, repo, num, raw));
  }
  for (const m of text.matchAll(GITHUB_SHORT)) {
    const [raw, num] = m;
    if (num) add(bare, m.index, raw, githubRef(options.defaultOwner, options.defaultRepo, num, raw));
  }
  if (projectKeys.size > 0) {
    for (const m of text.matchAll(JIRA_KEY)) {
      const [raw, project, num] = m;
      if (project && num && projectKeys.has(project.toUpperCase())) {
        add(bare, m.index, raw, { source: 'jira', id: `${project.toUpperCase()}-${num}`, raw });
      }
    }
  }

  // Nothing inside any URL counts as a bare ref (`/pull/12#issuecomment-1`, `example.com/PROJ-1`, …).
  const urlSpans = [...text.matchAll(ANY_URL)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
  const inside = (c: Candidate, spans: { start: number; end: number }[]) =>
    spans.some((s) => c.start < s.end && s.start < c.end);
  const accepted: Candidate[] = [];
  for (const c of linked.sort((a, b) => a.start - b.start)) if (!inside(c, accepted)) accepted.push(c);
  for (const c of bare.sort((a, b) => a.start - b.start)) {
    if (!inside(c, urlSpans) && !inside(c, accepted)) accepted.push(c);
  }

  const byKey = new Map<string, PrdRef>();
  for (const { ref } of accepted.sort((a, b) => a.start - b.start)) {
    const key = `${ref.source}:${ref.id.toLowerCase()}`;
    const first = byKey.get(key);
    if (!first) byKey.set(key, { ...ref });
    else if (!first.url && ref.url) first.url = ref.url; // `[PROJ-1](https://…/browse/PROJ-1)`
  }
  return [...byKey.values()].slice(0, options.maxDocuments);
};
