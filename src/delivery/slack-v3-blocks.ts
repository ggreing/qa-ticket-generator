/**
 * Slack messages for the v3 phases (SPEC v3 §2.2 verify, §5 plan). Pure: data in, Block Kit out.
 *
 *   verify: PR link, alignment badge and commit · spec and case counts · code status counts ·
 *           the cases the code contradicts or misses (ticket links) · [Open PR]
 *   plan:   spec title and link · case counts (P0/P1/P2, obsolete) · what changed ·
 *           [Open case list] [Open spec]
 *
 * Text written by the model (case and spec titles) goes through `slackText` like every other
 * model text (DLV-06): links outside the PR repository or the spec are defanged, `~` cannot strike
 * through, `@channel` cannot ping. Links this module adds (tickets, spec, list) come from the sinks
 * and providers and are used only when they are plain https URLs. Sections stay under Slack's
 * 3000-character limit by dropping whole lines, never by cutting inside a link.
 * Owner: qa-work-session-b.
 */
import type { KnownBlock } from '@slack/web-api';
import { OBSOLETE_LABEL } from '../cases';
import type { CaseSetSummary, CodeStatus, Priority } from '../core/cases';
import type { Language, PrdRef } from '../core/contracts';
import { strings } from './render/i18n';
import { ALIGNMENT_BADGE } from './render/markdown';
import { MAX_SECTION_CHARS, type SlackMessage } from './render/slack-blocks';
import {
  CODE_STATUS_ICON,
  type SummaryCase,
  type VerifySummaryInput,
  verifyStrings,
} from './render/verify-summary';
import { flatten, type LinkPolicy, slackText, truncate } from './sanitize';

/** Cases listed under "contradicts or missing" before the rest becomes "and N more". */
export const MAX_NOTICE_ITEMS = 5;
const MAX_TITLE_CHARS = 150;
const MAX_CASE_TITLE_CHARS = 120;
const MAX_FALLBACK_CHARS = 1_000;
/** Room kept in a section for the "and N more" line. */
const MORE_RESERVE = 40;

interface NoticeStrings {
  planTitle: string;
  openList: string;
  openSpec: string;
  changes: (created: number, updated: number, obsoleted: number) => string;
}

const NOTICE_STRINGS: Readonly<Record<Language, NoticeStrings>> = {
  en: {
    planTitle: 'QA cases planned',
    openList: 'Open case list',
    openSpec: 'Open spec',
    changes: (c, u, o) => `This run: ${c} new · ${u} updated · ${o} obsolete`,
  },
  ko: {
    planTitle: 'QA 케이스 생성',
    openList: '케이스 목록 열기',
    openSpec: '기획서 열기',
    changes: (c, u, o) => `이번 실행: 새 케이스 ${c} · 갱신 ${u} · 해당 없음 처리 ${o}`,
  },
  ja: {
    planTitle: 'QA ケース作成',
    openList: 'ケース一覧を開く',
    openSpec: '仕様書を開く',
    changes: (c, u, o) => `今回の実行: 新規 ${c} 件 · 更新 ${u} 件 · 対象外 ${o} 件`,
  },
  'zh-CN': {
    planTitle: 'QA 用例已生成',
    openList: '打开用例列表',
    openSpec: '打开需求文档',
    changes: (c, u, o) => `本次运行: 新增 ${c} 条 · 更新 ${u} 条 · 不再适用 ${o} 条`,
  },
};

/** The notice strings for a language (exported for tests). */
export const noticeStrings = (language: Language): NoticeStrings =>
  NOTICE_STRINGS[language] ?? NOTICE_STRINGS.en;

const SAFE_URL = /^https:\/\/[^\s<>()[\]"'`|\\]+$/;
const isSafeUrl = (url: string | undefined): url is string => !!url && SAFE_URL.test(url);

/** `<url|label>` for a plain https URL, else the label alone. `label` is already Slack-escaped. */
function link(url: string | undefined, label: string): string {
  return isSafeUrl(url) ? `<${url}|${label.replace(/\|/g, '¦')}>` : label;
}

const section = (text: string): KnownBlock => ({
  type: 'section',
  text: { type: 'mrkdwn', text: truncate(text, MAX_SECTION_CHARS) },
});

const context = (text: string): KnownBlock => ({ type: 'context', elements: [{ type: 'mrkdwn', text }] });

function buttons(items: { id: string; label: string; url: string | undefined }[]): KnownBlock | null {
  const elements = items
    .filter((b) => isSafeUrl(b.url))
    .map((b) => ({
      type: 'button' as const,
      action_id: b.id,
      text: { type: 'plain_text' as const, text: b.label },
      url: b.url as string,
    }));
  return elements.length > 0 ? { type: 'actions', elements } : null;
}

/** Heading plus as many whole lines as fit in one section, then "and N more". */
function listSection(heading: string, lines: string[], max: number, more: (n: number) => string): KnownBlock {
  let text = heading;
  let shown = 0;
  for (const line of lines.slice(0, max)) {
    if (text.length + 1 + line.length > MAX_SECTION_CHARS - MORE_RESERVE) break;
    text += `\n${line}`;
    shown++;
  }
  if (shown < lines.length) text += `\n… ${more(lines.length - shown)}`;
  return section(text);
}

const plain = (text: string, max: number, policy: LinkPolicy): string =>
  slackText(truncate(flatten(text), max), policy);

const caseIdLabel = (id: string): string => id.replace(/[^\w.-]/g, '');

function specLink(ref: PrdRef, title: string, policy: LinkPolicy): string {
  const name = link(ref.url, plain(ref.id, 80, policy));
  return `${name} ${plain(title, MAX_TITLE_CHARS, policy)}`;
}

function caseCounts(
  language: Language,
  active: number,
  byPriority: Record<Priority, number>,
  obsolete: number,
) {
  const v = verifyStrings(language);
  const counts = v.cases(active, byPriority.P0, byPriority.P1, byPriority.P2);
  return obsolete > 0 ? `${counts} · ${OBSOLETE_LABEL[language] ?? OBSOLETE_LABEL.en} ${obsolete}` : counts;
}

const STATUS_ORDER: Readonly<Record<CodeStatus | 'none', number>> = {
  contradicts: 0,
  missing: 1,
  unknown: 2,
  none: 3,
  implemented: 4,
};
const PRIORITY_ORDER: Readonly<Record<Priority, number>> = { P0: 0, P1: 1, P2: 2 };
const statusOf = (c: SummaryCase): CodeStatus | 'none' => c.codeStatus?.status ?? 'none';
const byUrgency = (a: SummaryCase, b: SummaryCase): number =>
  STATUS_ORDER[statusOf(a)] - STATUS_ORDER[statusOf(b)] ||
  PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
  a.caseId.localeCompare(b.caseId);

/** Model text may link only to the pull request's repository (as in the PR comment). */
function verifyPolicy(input: VerifySummaryInput): LinkPolicy {
  const host = /^https:\/\/([^/]+)\//.exec(input.pr.htmlUrl)?.[1] ?? 'github.com';
  return { allowed: [`${host}/${input.pr.owner}/${input.pr.repo}`.toLowerCase()] };
}

/** Model text in a plan notice may link only to the spec's repository or page. */
function planPolicy(ref: PrdRef): LinkPolicy {
  if (!isSafeUrl(ref.url)) return { allowed: [] };
  const u = new URL(ref.url);
  const path = u.pathname.replace(/\/+$/, '');
  const repo = u.host === 'github.com' ? (/^\/[^/]+\/[^/]+/.exec(path)?.[0] ?? path) : path;
  return { allowed: [`${u.host}${repo}`.toLowerCase()] };
}

/**
 * Verify notice (SPEC v3 §2.2): what a reviewer needs from Slack, with ticket links for detail.
 * The PR comment keeps the full summary; this message points there through the PR link.
 */
export function buildVerifyNotice(input: VerifySummaryInput): SlackMessage {
  const t = strings(input.language);
  const v = verifyStrings(input.language);
  const policy = verifyPolicy(input);
  const status = input.alignment.status;
  const sha = input.sha.slice(0, 7).replace(/[^0-9a-f]/gi, '');
  const prTitle = plain(input.pr.title, MAX_TITLE_CHARS, policy);
  const pr = link(input.pr.htmlUrl, `#${input.pr.number} ${prTitle}`);

  const active = input.cases.filter((c) => c.lifecycle === 'active');
  const byPriority: Record<Priority, number> = { P0: 0, P1: 0, P2: 0 };
  for (const c of active) byPriority[c.priority]++;
  const obsolete = input.cases.length - active.length;

  const blocks: KnownBlock[] = [
    section(
      `🧪 *${t.title}* — ${pr}\n${ALIGNMENT_BADGE[status]} *${t.alignmentStatus[status]}*${sha ? ` · \`${sha}\`` : ''}`,
    ),
    section(
      `${v.spec}: ${specLink(input.spec.ref, input.spec.title, policy)}\n${caseCounts(input.language, active.length, byPriority, obsolete)}`,
    ),
  ];

  const attention = active
    .filter((c) => statusOf(c) === 'contradicts' || statusOf(c) === 'missing')
    .sort(byUrgency);
  if (active.length === 0) {
    blocks.push(section(`ℹ️ ${v.noCases}`));
  } else {
    const counts = (['implemented', 'missing', 'contradicts', 'unknown'] as const).map(
      (s) => `${CODE_STATUS_ICON[s]} ${v.status[s]} ${active.filter((c) => statusOf(c) === s).length}`,
    );
    const notJudged = active.filter((c) => statusOf(c) === 'none').length;
    if (notJudged > 0) counts.push(`${v.notJudged} ${notJudged}`);
    blocks.push(section(`*${v.codeStatus}*: ${counts.join(' · ')}`));

    if (attention.length > 0) {
      const lines = attention.map(
        (c) =>
          `• ${CODE_STATUS_ICON[statusOf(c) as CodeStatus]} ${link(c.url, caseIdLabel(c.caseId))} *${c.priority}* ${plain(c.title, MAX_CASE_TITLE_CHARS, policy)}`,
      );
      blocks.push(listSection(`*${v.attention(attention.length)}*`, lines, MAX_NOTICE_ITEMS, t.more));
    } else {
      blocks.push(section(`✅ *${v.noAttention}*`));
    }
    const added = active.filter((c) => input.newCaseIds.includes(c.caseId)).length;
    if (added > 0) blocks.push(context(`➕ ${v.fromCode(added)}`));
  }

  const actions = buttons([{ id: 'qtg_open_pr', label: t.slack.openPr, url: input.pr.htmlUrl }]);
  if (actions) blocks.push(actions);
  const cost = input.meta.calls > 0 ? ` · ~$${input.meta.costUsd.toFixed(2)}` : '';
  const dry = input.meta.dryRun ? ` · ${t.dryRun}` : '';
  blocks.push(context(`${sha ? `\`${sha}\` · ` : ''}${plain(input.meta.model, 60, policy)}${cost}${dry}`));

  const fallback = `${t.title} — #${input.pr.number} ${prTitle}: ${t.alignmentStatus[status]}, ${v.attention(attention.length)}`;
  return { text: truncate(fallback, MAX_FALLBACK_CHARS), blocks };
}

/** What a plan run changed in its primary sink; shown when given. */
export interface PlanChanges {
  created: number;
  updated: number;
  obsoleted: number;
}

/**
 * Plan notice (SPEC v3 §5): the spec, how many cases it has now and where the list lives.
 * `listUrl` is the spec-side overview a sink published (issue comment, Jira story, file index).
 */
export function buildPlanNotice(
  summary: CaseSetSummary,
  opts: { listUrl?: string; changes?: PlanChanges } = {},
): SlackMessage {
  const n = noticeStrings(summary.language);
  const policy = planPolicy(summary.specRef);
  const spec = specLink(summary.specRef, summary.specTitle, policy);
  const { total, byPriority, obsolete } = summary.counts;

  const lines = [caseCounts(summary.language, total, byPriority, obsolete)];
  if (opts.changes) lines.push(n.changes(opts.changes.created, opts.changes.updated, opts.changes.obsoleted));
  const blocks: KnownBlock[] = [section(`📋 *${n.planTitle}* — ${spec}`), section(lines.join('\n'))];

  const actions = buttons([
    { id: 'qtg_open_case_list', label: n.openList, url: opts.listUrl },
    { id: 'qtg_open_spec', label: n.openSpec, url: summary.specRef.url },
  ]);
  if (actions) blocks.push(actions);
  const cost = summary.meta.costUsd > 0 ? ` · ~$${summary.meta.costUsd.toFixed(2)}` : '';
  blocks.push(context(`${plain(summary.meta.model, 60, policy)}${cost}`));

  const fallback = `${n.planTitle} — ${plain(summary.specRef.id, 80, policy)} ${plain(summary.specTitle, MAX_TITLE_CHARS, policy)}: ${lines[0]}`;
  return { text: truncate(fallback, MAX_FALLBACK_CHARS), blocks };
}
