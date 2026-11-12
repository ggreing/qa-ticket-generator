/** Slack Block Kit rendering: summary card + thread details (SPEC §4.6, DLV-04/05/06). Owner: qa-work-session-c(fable). */
import type { KnownBlock } from '@slack/web-api';
import type { FinalReport, QaReport } from '../../core/contracts';
import { type LinkPolicy, linkPolicyFor, slackText, truncate } from '../sanitize';
import { type Strings, strings } from './i18n';
import { ALIGNMENT_BADGE, SEVERITY_ICON } from './markdown';

/** Slack limits: 50 blocks per message and 3000 characters per section text. */
export const MAX_BLOCKS_PER_MESSAGE = 45;
export const MAX_SECTION_CHARS = 3_000;
const MAX_TITLE_CHARS = 150;
const TOP_RISKS = 3;
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 } as const;

export interface SlackMessage {
  /** Plain-text fallback shown in notifications. */
  text: string;
  blocks: KnownBlock[];
}

type Scenario = QaReport['scenarios'][number];

/** Localized "what to do" line for error codes that have one (SPEC §10), e.g. `cost_cap`. */
function errorHint(final: FinalReport, t: Strings): string {
  const hint = final.error ? t.errorHint[final.error.code] : undefined;
  return hint
    ? `
💡 ${hint}`
    : '';
}

const section = (text: string): KnownBlock => ({
  type: 'section',
  text: { type: 'mrkdwn', text: truncate(text, MAX_SECTION_CHARS) },
});

function prLink(final: FinalReport, policy: LinkPolicy): string {
  const title = slackText(truncate(final.pr.title, MAX_TITLE_CHARS), policy).replace(/\|/g, '¦');
  return `<${final.pr.htmlUrl}|#${final.pr.number} ${title}>`;
}

function buttons(final: FinalReport, t: Strings, fullReportUrl: string): KnownBlock {
  return {
    type: 'actions',
    elements: [
      {
        type: 'button',
        action_id: 'qtg_open_pr',
        text: { type: 'plain_text', text: t.slack.openPr },
        url: final.pr.htmlUrl,
      },
      {
        type: 'button',
        action_id: 'qtg_view_report',
        text: { type: 'plain_text', text: t.slack.viewReport },
        url: fullReportUrl,
      },
    ],
  };
}

function metaLine(final: FinalReport): KnownBlock {
  const { meta } = final;
  const cost = meta.calls > 0 ? ` · ~$${meta.costUsd.toFixed(2)}` : '';
  return {
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `\`${meta.sha.slice(0, 7)}\` · ${meta.model}${cost}` }],
  };
}

/**
 * Parent message: PR title, alignment badge, scenario counts by priority, top three risks and the
 * `[Open PR]` / `[View full report]` buttons. Error and "no files" runs get a one-line status card.
 */
export function buildSummaryCard(final: FinalReport, fullReportUrl: string): SlackMessage {
  const t = strings(final.language);
  const policy = linkPolicyFor(final);
  const title = `🧪 *${t.title}* — ${prLink(final, policy)}`;
  const plainTitle = `${t.title} — #${final.pr.number} ${truncate(final.pr.title, MAX_TITLE_CHARS)}`;

  if (final.status !== 'ok' || !final.report) {
    const status =
      final.status === 'error'
        ? `❌ *${t.runFailed}*${final.error ? ` — ${slackText(final.error.message, policy)}` : ''}${errorHint(final, t)}`
        : `ℹ️ ${final.skipReason === 'no_files' ? t.noFiles : t.skipped}`;
    return {
      text: `${plainTitle}: ${final.status === 'error' ? t.runFailed : t.skipped}`,
      blocks: [section(title), section(status), buttons(final, t, fullReportUrl), metaLine(final)],
    };
  }

  const { report } = final;
  const status = report.prdAlignment.status;
  const count = (p: Scenario['priority']) => report.scenarios.filter((s) => s.priority === p).length;
  const blocks: KnownBlock[] = [
    section(title),
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*${t.alignment}*\n${ALIGNMENT_BADGE[status]} ${t.alignmentStatus[status]}` },
        {
          type: 'mrkdwn',
          text: `*${t.slack.scenarios}*\n${report.scenarios.length} (P0 ${count('P0')} · P1 ${count('P1')} · P2 ${count('P2')})`,
        },
      ],
    },
  ];
  if (status === 'no_prd') {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `⚠️ ${t.noPrd}` }] }); // DLV-09
  }
  if (report.summary.trim()) blocks.push(section(slackText(report.summary, policy)));
  const risks = [...report.risks]
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
    .slice(0, TOP_RISKS);
  if (risks.length > 0) {
    blocks.push(
      section(
        `*${t.slack.topRisks}*\n${risks.map((r) => `• ${SEVERITY_ICON[r.severity]} ${slackText(truncate(r.title, 200), policy)}`).join('\n')}`,
      ),
    );
  }
  blocks.push(buttons(final, t, fullReportUrl), metaLine(final));
  return {
    text: `${plainTitle}: ${t.alignment} ${t.alignmentStatus[status]}, ${report.scenarios.length} ${t.slack.scenarios}`,
    blocks,
  };
}

function scenarioSection(s: Scenario, t: Strings, policy: LinkPolicy): KnownBlock {
  const step = (keyword: string, items: string[]): string[] =>
    items
      .filter((i) => i.trim() !== '')
      .map((item, i) => `*${i === 0 ? keyword : 'And'}* ${slackText(item, policy)}`);
  const related = [
    ...s.relatedRequirements.map((r) => slackText(r, policy)),
    ...s.relatedFiles.map((f) => `\`${slackText(f, policy).replace(/`/g, "'")}\``),
  ];
  const lines = [
    `*[${s.priority}][${t.scenarioType[s.type]}] ${slackText(s.id, policy)} · ${slackText(s.title, policy)}*`,
    ...step('Given', s.given),
    ...step('When', s.when),
    ...step('Then', s.then),
  ];
  if (related.length > 0) lines.push(`_${t.related}_: ${related.join(' · ')}`);
  return section(lines.join('\n'));
}

/**
 * Thread replies: requirements that are not covered, then one section per scenario, split into
 * messages of at most 45 blocks. Returns an empty list when there is nothing to detail.
 */
export function buildThreadMessages(final: FinalReport): SlackMessage[] {
  if (final.status !== 'ok' || !final.report) return [];
  const t = strings(final.language);
  const policy = linkPolicyFor(final);
  const blocks: KnownBlock[] = [];

  const open = final.report.prdAlignment.findings.filter((f) => f.status !== 'covered');
  if (open.length > 0) {
    const rows = open.map(
      (f) =>
        `• *${t.requirementStatus[f.status]}* — ${slackText(f.requirement, policy)}: ${slackText(f.evidence, policy)}`,
    );
    blocks.push(section(`*${t.slack.findings}*\n${rows.join('\n')}`));
  }
  for (const s of final.report.scenarios) blocks.push(scenarioSection(s, t, policy));

  const messages: SlackMessage[] = [];
  for (let i = 0; i < blocks.length; i += MAX_BLOCKS_PER_MESSAGE) {
    const part = Math.floor(i / MAX_BLOCKS_PER_MESSAGE) + 1;
    const total = Math.ceil(blocks.length / MAX_BLOCKS_PER_MESSAGE);
    messages.push({
      text: `${t.slack.scenarios} (${part}/${total})`,
      blocks: blocks.slice(i, i + MAX_BLOCKS_PER_MESSAGE),
    });
  }
  return messages;
}
