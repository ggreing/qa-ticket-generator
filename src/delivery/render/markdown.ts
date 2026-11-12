/**
 * PR comment Markdown renderer in the QA-ticket layout (SPEC §4.6 M3.5, DLV-03/06/09), i18n
 * en/ko/ja/zh-CN. Order: verdict, action needed, P0 checklist, P0 ticket cards, P1/P2 cards in
 * one fold, verdict per requirement, risks, assumptions, notes, footer.
 * Owner: qa-work-session-c(fable).
 */
import type { FinalReport, PrdRef, QaReport, RunMeta } from '../../core/contracts';
import { isAllowedUrl, type LinkPolicy, linkPolicyFor, mdCode, mdInline } from '../sanitize';
import { type Strings, strings } from './i18n';
import {
  actionFindings,
  expectedSummary,
  type Finding,
  lead,
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

/** GitHub rejects issue comments longer than this. */
export const MAX_COMMENT_CHARS = 65_536;
/** Room kept free for the marker and the hidden state block that the comment store appends. */
export const STATE_RESERVE = 1_024;

export const ALIGNMENT_BADGE = { aligned: '✅', partial: '⚠️', misaligned: '❌', no_prd: '➖' } as const;
export const SEVERITY_ICON = { high: '🔴', medium: '🟠', low: '🟡' } as const;
export const REQUIREMENT_ICON = { covered: '✅', missing: '❌', contradicts: '⛔', unclear: '❓' } as const;
const SOURCE_LABEL = { github: 'GitHub', jira: 'Jira', notion: 'Notion' } as const;
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 } as const;

interface RenderOptions {
  /** Maximum length of the result; `Infinity` for the Job Summary. */
  limit: number;
  /** Adds the skipped-file and redaction listings (Job Summary / CLI). */
  detailed: boolean;
}

/** Formats a token count the way the footer shows it: `812`, `31.2K`, `1.25M`. */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

/** Short display id for a PRD reference (Notion page ids are 32 hex characters). */
export function refLabel(ref: PrdRef): string {
  return ref.source === 'notion' && ref.id.length > 12 ? `${ref.id.slice(0, 8)}…` : ref.id;
}

function header(final: FinalReport, t: Strings): string {
  const base = `## 🧪 ${t.title} — ${mdCode(final.meta.sha.slice(0, 7))}`;
  if (final.status !== 'ok' || !final.report) return base;
  const status = final.report.prdAlignment.status;
  return `${base} · ${ALIGNMENT_BADGE[status]} **${t.alignmentStatus[status]}**`;
}

function linkedLine(refs: PrdRef[], t: Strings, policy: LinkPolicy): string | null {
  if (refs.length === 0) return null;
  const items = refs.map((ref) => {
    const label = mdInline(refLabel(ref), policy);
    const linked = ref.url && isAllowedUrl(ref.url, policy) ? `[${label}](${encodeURI(ref.url)})` : label;
    return `${linked} (${SOURCE_LABEL[ref.source]})`;
  });
  return `> ${t.linked}: ${items.join(', ')}`;
}

/** One line of the top lists: `❌ **AC2** short requirement — first sentence of the evidence <code>file</code>`. */
function findingLine(f: Finding, policy: LinkPolicy): string {
  const { label, text } = splitRequirement(f.requirement);
  const name = label ? `**${mdInline(label, policy)}** ` : '';
  const file = f.files[0]
    ? ` ${mdCode(f.files[0])}${f.files.length > 1 ? ` +${f.files.length - 1}` : ''}`
    : '';
  const evidence = f.evidence.trim() ? ` — ${mdInline(lead(f.evidence, MAX_EVIDENCE_CHARS), policy)}` : '';
  return `- ${REQUIREMENT_ICON[f.status]} ${name}${mdInline(lead(text, MAX_REQUIREMENT_CHARS), policy)}${evidence}${file}`;
}

function capped(lines: string[], max: number, t: Strings): string[] {
  return lines.length > max ? [...lines.slice(0, max), `- … ${t.more(lines.length - max)}`] : lines;
}

/** The part a reviewer reads without unfolding anything: what to fix, then what to test first. */
function topSection(report: QaReport, t: Strings, policy: LinkPolicy): string[] {
  const out: string[] = [];
  const findings = report.prdAlignment.findings;
  const action = actionFindings(report);
  const unclear = unclearFindings(report);
  if (action.length > 0) {
    out.push(`**${t.actionNeeded(action.length)}**`);
    out.push(
      ...capped(
        action.map((f) => findingLine(f, policy)),
        MAX_ACTION_ITEMS,
        t,
      ),
      '',
    );
  } else if (findings.length > 0 && unclear.length === 0) {
    out.push(`✅ **${t.allCovered(findings.length)}**`, '');
  }
  if (unclear.length > 0) {
    out.push(`**${t.needsCheck(unclear.length)}**`);
    out.push(
      ...capped(
        unclear.map((f) => findingLine(f, policy)),
        MAX_ACTION_ITEMS,
        t,
      ),
      '',
    );
  }

  const p0 = report.scenarios.filter((s) => s.priority === 'P0');
  if (p0.length > 0) {
    out.push(`**${t.p0Checklist(p0.length)}**`);
    const lines = p0.map((s) => {
      const expected = expectedSummary(s);
      return `- [ ] **${mdInline(s.id, policy)}** ${mdInline(s.title, policy)}${expected ? ` → ${mdInline(expected, policy)}` : ''}`;
    });
    out.push(...capped(lines, MAX_CHECKLIST_ITEMS, t), '');
  } else if (report.scenarios.length > 0) {
    out.push(`_${t.noP0}_`, '');
  }
  return out;
}

function listField(label: string, items: string[], policy: LinkPolicy, ordered = false): string[] {
  const values = nonEmpty(items);
  if (values.length === 0) return [];
  if (values.length === 1 && !ordered) return [`- **${label}**: ${mdInline(values[0] as string, policy)}`];
  return [
    `- **${label}**:`,
    ...values.map((value, i) => `  ${ordered ? `${i + 1}.` : '-'} ${mdInline(value, policy)}`),
  ];
}

/** A folded ticket: preconditions, data, numbered steps, expected result, related requirement and files. */
function ticketCard(s: Scenario, t: Strings, policy: LinkPolicy): string {
  const lines = [
    `<details><summary><b>${mdInline(s.id, policy)} ${mdInline(s.title, policy)}</b> [${mdInline(ticketTag(s), policy)}]</summary>`,
    '',
    ...listField(t.card.given, s.given, policy),
  ];
  const data = nonEmpty(s.testData);
  if (data.length > 0) lines.push(`- **${t.card.data}**: ${data.map(mdCode).join(' · ')}`);
  lines.push(...listField(t.card.steps, s.when, policy, true), ...listField(t.card.expected, s.then, policy));
  const related = [
    ...nonEmpty(s.relatedRequirements).map((r) => mdInline(r, policy)),
    ...s.relatedFiles.map(mdCode),
  ];
  if (related.length > 0) lines.push(`- **${t.card.related}**: ${related.join(' · ')}`);
  // Confidence is shown only when the model flagged doubt; "high" is the unmarked case.
  if (s.rationale.trim()) lines.push(`- **${t.card.why}**: ${mdInline(s.rationale, policy)}`);
  if (s.confidence !== 'high') lines.push(`- **${t.confidence}**: ${t.level[s.confidence]}`);
  lines.push('', '</details>');
  return lines.join('\n');
}

function findingRow(f: Finding, t: Strings, policy: LinkPolicy, showSource: boolean): string {
  const source = showSource && f.source.trim() ? ` · ${mdCode(f.source)}` : '';
  const files = f.files.length > 0 ? ` ${f.files.map(mdCode).join(' ')}` : '';
  return `| ${mdInline(f.requirement, policy)}${source} | ${REQUIREMENT_ICON[f.status]} ${t.requirementStatus[f.status]} | ${mdInline(f.evidence, policy)}${files} |`;
}

function footer(meta: RunMeta, t: Strings): string {
  const parts: string[] = [mdCode(meta.model), `effort ${meta.effort}`];
  if (meta.mode !== 'none') parts.push(meta.mode);
  const u = meta.usage;
  if (meta.calls > 0) {
    parts.push(
      t.footer.tokens(
        formatTokens(u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens),
        formatTokens(u.outputTokens),
      ),
    );
    if (u.cacheReadTokens + u.cacheWriteTokens > 0) {
      parts.push(t.footer.cache(formatTokens(u.cacheReadTokens), formatTokens(u.cacheWriteTokens)));
    }
    parts.push(`~$${meta.costUsd.toFixed(2)}`);
    if (meta.calls > 1) parts.push(t.footer.calls(meta.calls));
  }
  parts.push(`${Math.round(meta.durationMs / 1000)}s`);
  if (meta.skipped.length > 0) {
    const byReason = new Map<string, number>();
    for (const s of meta.skipped) byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
    const detail = [...byReason].map(
      ([reason, n]) => `${t.skipReason[reason as keyof Strings['skipReason']] ?? reason} ${n}`,
    );
    parts.push(`${t.footer.filesSkipped(meta.skipped.length)} (${detail.join(', ')})`);
  }
  const redacted = meta.redactions.reduce((sum, r) => sum + r.count, 0);
  if (redacted > 0) parts.push(t.footer.redactions(redacted));
  if (meta.dryRun) parts.push(t.dryRun);
  return `<sub>${parts.join(' · ')}</sub>`;
}

function notes(meta: RunMeta, t: Strings, policy: LinkPolicy): string[] {
  if (meta.warnings.length === 0) return [];
  return [
    `### ${t.sections.notes}`,
    '',
    ...meta.warnings.map((w) => `- ⚠️ ${mdInline(w.message, policy)}`),
    '',
  ];
}

function details(meta: RunMeta, t: Strings): string[] {
  const out: string[] = [];
  if (meta.skipped.length > 0) {
    out.push(
      `<details><summary>${t.sections.skippedFiles} (${meta.skipped.length})</summary>`,
      '',
      ...meta.skipped.map((s) => `- ${mdCode(s.path)} — ${t.skipReason[s.reason] ?? s.reason}`),
      '',
      '</details>',
      '',
    );
  }
  if (meta.redactions.length > 0) {
    out.push(
      `<details><summary>${t.sections.redactions} (${meta.redactions.reduce((n, r) => n + r.count, 0)})</summary>`,
      '',
      ...meta.redactions.map((r) => `- ${mdCode(r.type)} × ${r.count}`),
      '',
      '</details>',
      '',
    );
  }
  return out;
}

function renderOk(
  final: FinalReport,
  report: QaReport,
  t: Strings,
  policy: LinkPolicy,
  opts: RenderOptions,
): string {
  const { meta } = final;
  const head: string[] = [header(final, t), ''];
  if (report.prdAlignment.status === 'no_prd') head.push(`> ⚠️ ${t.noPrd}`); // DLV-09
  const linked = linkedLine(meta.prdSources, t, policy);
  if (linked) head.push(linked);
  if (head.length > 2) head.push('');
  head.push(...topSection(report, t, policy));

  // Scenarios arrive sorted P0 → P2 (normalizeReport), so P0 cards come first and stay unfolded
  // one level; everything else shares a single fold.
  const p0Cards = report.scenarios.filter((s) => s.priority === 'P0').map((s) => ticketCard(s, t, policy));
  const otherCards = report.scenarios.filter((s) => s.priority !== 'P0').map((s) => ticketCard(s, t, policy));
  const showSource = new Set(report.prdAlignment.findings.map((f) => f.source.trim())).size > 1;
  const findingRows = report.prdAlignment.findings.map((f) => findingRow(f, t, policy, showSource));

  const tail: string[] = [];
  if (report.risks.length > 0) {
    const risks = [...report.risks].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
    tail.push(`### ${t.sections.risks}`, '');
    for (const r of risks) {
      const files = r.files.length > 0 ? ` ${r.files.map(mdCode).join(' ')}` : '';
      tail.push(
        `- ${SEVERITY_ICON[r.severity]} **${mdInline(r.title, policy)}** — ${mdInline(r.description, policy)}${files}`,
      );
    }
    tail.push('');
  }
  const assumptions = report.assumptions.filter((a) => a.trim() !== '');
  if (assumptions.length > 0) {
    tail.push(`### ${t.sections.assumptions}`, '', ...assumptions.map((a) => `- ${mdInline(a, policy)}`), '');
  }
  tail.push(...notes(meta, t, policy));
  if (opts.detailed) tail.push(...details(meta, t));
  tail.push(footer(meta, t));

  const total = p0Cards.length + otherCards.length;
  const compose = (cardCount: number, findingCount: number): string => {
    const lines = [...head];
    for (const card of p0Cards.slice(0, cardCount)) lines.push(card, '');
    const others = otherCards.slice(0, Math.max(0, cardCount - p0Cards.length));
    if (others.length > 0) {
      lines.push(`<details><summary>${t.otherTickets(otherCards.length)}</summary>`, '');
      for (const card of others) lines.push(card, '');
      lines.push('</details>', '');
    }
    if (cardCount < total) lines.push(`> ${t.omittedTickets(total - cardCount)}`, '');

    if (findingRows.length > 0 || report.summary.trim()) {
      lines.push(`<details><summary>${t.requirementDetails(findingRows.length)}</summary>`, '');
      if (report.summary.trim()) lines.push(mdInline(report.summary, policy), '');
      if (findingRows.length > 0) {
        lines.push(
          `| ${t.table.requirement} | ${t.table.status} | ${t.table.evidence} |`,
          '| --- | --- | --- |',
          ...findingRows.slice(0, findingCount),
          '',
        );
        if (findingCount < findingRows.length) {
          lines.push(`> ${t.omittedFindings(findingRows.length - findingCount)}`, '');
        }
      }
      lines.push('</details>', '');
    }
    lines.push(...tail);
    return lines.join('\n');
  };

  // DLV-03: when the comment is too long, drop ticket cards from the lowest priority upward (the
  // top section keeps every P0 title), then requirement rows, then cut.
  let cardCount = total;
  let findingCount = findingRows.length;
  let body = compose(cardCount, findingCount);
  while (body.length > opts.limit && cardCount > 0) body = compose(--cardCount, findingCount);
  while (body.length > opts.limit && findingCount > 0) body = compose(cardCount, --findingCount);
  return hardLimit(body, opts.limit, t);
}

function hardLimit(body: string, limit: number, t: Strings): string {
  if (body.length <= limit) return body;
  const notice = `\n\n> ${t.truncated}`;
  const cut = body.slice(0, Math.max(0, limit - notice.length));
  const lastBreak = cut.lastIndexOf('\n');
  return `${lastBreak > 0 ? cut.slice(0, lastBreak) : cut}${notice}`;
}

function renderReport(final: FinalReport, opts: RenderOptions): string {
  const t = strings(final.language);
  const policy = linkPolicyFor(final);
  if (final.status === 'ok' && final.report) return renderOk(final, final.report, t, policy, opts);

  const lines = [header(final, t), ''];
  if (final.status === 'error') {
    const message = final.error?.message ?? '';
    lines.push(`❌ **${t.runFailed}**${message ? ` — ${mdInline(message, policy)}` : ''}`, '');
    const hint = final.error ? t.errorHint[final.error.code] : undefined;
    if (hint) lines.push(`> 💡 ${hint}`, '');
    if (final.error?.code) lines.push(`${t.errorCode}: ${mdCode(final.error.code)}`, '');
  } else if (final.skipReason === 'no_files') {
    lines.push(`ℹ️ ${t.noFiles}`, '');
  } else {
    lines.push(`ℹ️ ${t.skipped}${final.skipReason ? `: ${mdCode(final.skipReason)}` : ''}`, '');
  }
  lines.push(...notes(final.meta, t, policy));
  if (opts.detailed) lines.push(...details(final.meta, t));
  lines.push(footer(final.meta, t));
  return hardLimit(lines.join('\n'), opts.limit, t);
}

/**
 * Renders the PR comment body (SPEC §4.6) for an ok / error / skipped run. Every model- or
 * user-authored string is sanitized (DLV-06) and the result always fits GitHub's comment limit
 * with room for the marker and state block (DLV-03). The comment store adds those two.
 */
export function renderPrComment(final: FinalReport): string {
  return renderReport(final, { limit: MAX_COMMENT_CHARS - STATE_RESERVE, detailed: false });
}

/** Renders the full report for the Job Summary / CLI: no length cap, plus skipped files and redactions (DLV-07). */
export function renderSummaryMarkdown(final: FinalReport): string {
  return renderReport(final, { limit: Number.POSITIVE_INFINITY, detailed: true });
}
