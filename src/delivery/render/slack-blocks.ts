/**
 * Slack Block Kit rendering in the QA-ticket layout (SPEC §4.6 M3.5, DLV-04/05/06): the parent
 * card carries the verdict, what needs action and the P0 checklist; the thread carries one
 * ticket card per scenario. Owner: qa-work-session-c(fable).
 */
import type { KnownBlock } from '@slack/web-api';
import type { FinalReport, QaReport } from '../../core/contracts';
import { type LinkPolicy, linkPolicyFor, slackText, truncate } from '../sanitize';
import { type Strings, strings } from './i18n';
import { ALIGNMENT_BADGE, REQUIREMENT_ICON, SEVERITY_ICON } from './markdown';
import {
  actionFindings,
  expectedSummary,
  type Finding,
  MAX_ACTION_ITEMS,
  MAX_CHECKLIST_ITEMS,
  MAX_EVIDENCE_CHARS,
  MAX_REQUIREMENT_CHARS,
  nonEmpty,
  type Scenario,
  splitRequirement,
  ticketTag,
  unclearFindings,
} from './ticket';

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

/** Localized "what to do" line for error codes that have one (SPEC §10), e.g. `cost_cap`. */
function errorHint(final: FinalReport, t: Strings): string {
  const hint = final.error ? t.errorHint[final.error.code] : undefined;
  return hint ? `\n💡 ${hint}` : '';
}

const section = (text: string): KnownBlock => ({
  type: 'section',
  text: { type: 'mrkdwn', text: truncate(text, MAX_SECTION_CHARS) },
});

const code = (text: string, policy: LinkPolicy): string =>
  `\`${slackText(text, policy).replace(/`/g, "'")}\``;

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

function findingLine(f: Finding, policy: LinkPolicy): string {
  const { label, text } = splitRequirement(f.requirement);
  const name = label ? `*${slackText(label, policy)}* ` : '';
  const evidence = f.evidence.trim()
    ? ` — ${slackText(truncate(f.evidence, MAX_EVIDENCE_CHARS), policy)}`
    : '';
  const file = f.files[0] ? ` ${code(f.files[0], policy)}` : '';
  return `• ${REQUIREMENT_ICON[f.status]} ${name}${slackText(truncate(text, MAX_REQUIREMENT_CHARS), policy)}${evidence}${file}`;
}

const capped = (lines: string[], max: number, t: Strings): string[] =>
  lines.length > max ? [...lines.slice(0, max), `… ${t.more(lines.length - max)}`] : lines;

/**
 * Parent message: PR title and verdict, what needs action, the P0 checklist and the
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
  const verdict = `${ALIGNMENT_BADGE[status]} *${t.alignmentStatus[status]}* · ${t.slack.tickets} ${report.scenarios.length} (P0 ${count('P0')} · P1 ${count('P1')} · P2 ${count('P2')})`;
  const blocks: KnownBlock[] = [section(`${title}\n${verdict}`)];
  if (status === 'no_prd') {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `⚠️ ${t.noPrd}` }] }); // DLV-09
  }

  const action = actionFindings(report);
  const unclear = unclearFindings(report);
  if (action.length > 0) {
    const lines = capped(
      action.map((f) => findingLine(f, policy)),
      MAX_ACTION_ITEMS,
      t,
    );
    blocks.push(section(`*${t.actionNeeded(action.length)}*\n${lines.join('\n')}`));
  } else if (report.prdAlignment.findings.length > 0 && unclear.length === 0) {
    blocks.push(section(`✅ *${t.allCovered(report.prdAlignment.findings.length)}*`));
  }
  if (unclear.length > 0) {
    const lines = capped(
      unclear.map((f) => findingLine(f, policy)),
      MAX_ACTION_ITEMS,
      t,
    );
    blocks.push(section(`*${t.needsCheck(unclear.length)}*\n${lines.join('\n')}`));
  }

  const p0 = report.scenarios.filter((s) => s.priority === 'P0');
  if (p0.length > 0) {
    const lines = p0.map((s) => {
      const expected = expectedSummary(s);
      return `☐ *${slackText(s.id, policy)}* ${slackText(s.title, policy)}${expected ? ` → ${slackText(expected, policy)}` : ''}`;
    });
    blocks.push(
      section(`*${t.p0Checklist(p0.length)}*\n${capped(lines, MAX_CHECKLIST_ITEMS, t).join('\n')}`),
    );
  }
  blocks.push(buttons(final, t, fullReportUrl), metaLine(final));
  return {
    text: `${plainTitle}: ${t.alignmentStatus[status]}, ${t.actionNeeded(action.length)}, ${t.p0Checklist(p0.length)}`,
    blocks,
  };
}

/** One ticket as a section: title and tag, then preconditions, data, numbered steps, expected, files. */
function ticketSection(s: Scenario, t: Strings, policy: LinkPolicy): KnownBlock {
  const joined = (items: string[]): string =>
    nonEmpty(items)
      .map((i) => slackText(i, policy))
      .join(' · ');
  const lines = [
    `*${slackText(s.id, policy)} ${slackText(s.title, policy)}* [${slackText(ticketTag(s), policy)}]`,
  ];
  if (joined(s.given)) lines.push(`*${t.card.given}*: ${joined(s.given)}`);
  const data = nonEmpty(s.testData);
  if (data.length > 0) lines.push(`*${t.card.data}*: ${data.map((d) => code(d, policy)).join(' · ')}`);
  const steps = nonEmpty(s.when);
  if (steps.length > 0) {
    lines.push(
      `*${t.card.steps}*: ${steps.map((step, i) => `${i + 1}) ${slackText(step, policy)}`).join(' ')}`,
    );
  }
  if (joined(s.then)) lines.push(`*${t.card.expected}*: ${joined(s.then)}`);
  if (s.relatedFiles.length > 0) lines.push(s.relatedFiles.map((f) => code(f, policy)).join(' '));
  return section(lines.join('\n'));
}

function risksSection(report: QaReport, t: Strings, policy: LinkPolicy): KnownBlock | null {
  const risks = [...report.risks]
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
    .slice(0, TOP_RISKS);
  if (risks.length === 0) return null;
  const lines = risks.map(
    (r) => `• ${SEVERITY_ICON[r.severity]} ${slackText(truncate(r.title, 200), policy)}`,
  );
  return section(`*${t.sections.risks}*\n${lines.join('\n')}`);
}

/**
 * Thread replies: one section per ticket (P0 first), then the top risks, split into messages of
 * at most 45 blocks. Returns an empty list when there is nothing to detail.
 */
export function buildThreadMessages(final: FinalReport): SlackMessage[] {
  if (final.status !== 'ok' || !final.report) return [];
  const t = strings(final.language);
  const policy = linkPolicyFor(final);
  const blocks: KnownBlock[] = final.report.scenarios.map((s) => ticketSection(s, t, policy));
  const risks = risksSection(final.report, t, policy);
  if (risks) blocks.push(risks);

  const messages: SlackMessage[] = [];
  for (let i = 0; i < blocks.length; i += MAX_BLOCKS_PER_MESSAGE) {
    const part = Math.floor(i / MAX_BLOCKS_PER_MESSAGE) + 1;
    const total = Math.ceil(blocks.length / MAX_BLOCKS_PER_MESSAGE);
    messages.push({
      text: `${t.slack.tickets} (${part}/${total})`,
      blocks: blocks.slice(i, i + MAX_BLOCKS_PER_MESSAGE),
    });
  }
  return messages;
}
