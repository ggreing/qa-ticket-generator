/** PR comment Markdown renderer, i18n en/ko/ja/zh-CN (SPEC §4.6, DLV-03/06/09). Owner: qa-work-session-c(fable). */
import type { FinalReport, PrdRef, QaReport, RunMeta } from '../../core/contracts';
import { isAllowedUrl, type LinkPolicy, linkPolicyFor, mdCode, mdInline } from '../sanitize';
import { type Strings, strings } from './i18n';

/** GitHub rejects issue comments longer than this. */
export const MAX_COMMENT_CHARS = 65_536;
/** Room kept free for the marker and the hidden state block that the comment store appends. */
export const STATE_RESERVE = 1_024;

export const ALIGNMENT_BADGE = { aligned: '✅', partial: '⚠️', misaligned: '❌', no_prd: '➖' } as const;
export const SEVERITY_ICON = { high: '🔴', medium: '🟠', low: '🟡' } as const;
const REQUIREMENT_ICON = { covered: '✅', missing: '❌', contradicts: '⛔', unclear: '❓' } as const;
const SOURCE_LABEL = { github: 'GitHub', jira: 'Jira', notion: 'Notion' } as const;
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 } as const;

type Scenario = QaReport['scenarios'][number];
type Finding = QaReport['prdAlignment']['findings'][number];

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
  return `${base} · ${ALIGNMENT_BADGE[status]} ${t.alignment}: **${t.alignmentStatus[status]}**`;
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

function findingRow(f: Finding, t: Strings, policy: LinkPolicy, showSource: boolean): string {
  const source = showSource && f.source.trim() ? ` · ${mdCode(f.source)}` : '';
  const files = f.files.length > 0 ? ` ${f.files.map(mdCode).join(' ')}` : '';
  return `| ${mdInline(f.requirement, policy)}${source} | ${REQUIREMENT_ICON[f.status]} ${t.requirementStatus[f.status]} | ${mdInline(f.evidence, policy)}${files} |`;
}

function steps(keyword: string, items: string[], policy: LinkPolicy): string[] {
  return items
    .filter((item) => item.trim() !== '')
    .map((item, i) => `- **${i === 0 ? keyword : 'And'}** ${mdInline(item, policy)}`);
}

function scenarioBlock(s: Scenario, t: Strings, policy: LinkPolicy): string {
  const related = [...s.relatedRequirements.map((r) => mdInline(r, policy)), ...s.relatedFiles.map(mdCode)];
  const lines = [
    `<details><summary><b>[${s.priority}][${t.scenarioType[s.type]}] ${mdInline(s.id, policy)} · ${mdInline(s.title, policy)}</b></summary>`,
    '',
    ...steps('Given', s.given, policy),
    ...steps('When', s.when, policy),
    ...steps('Then', s.then, policy),
  ];
  if (related.length > 0) lines.push(`- _${t.related}_: ${related.join(' · ')}`);
  const why = s.rationale.trim() ? `_${t.why}_: ${mdInline(s.rationale, policy)} · ` : '';
  lines.push(`- ${why}_${t.confidence}_: ${t.level[s.confidence]}`, '', '</details>');
  return lines.join('\n');
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
  if (report.summary.trim()) head.push(mdInline(report.summary, policy), '');

  const showSource = new Set(report.prdAlignment.findings.map((f) => f.source.trim())).size > 1;
  const findingRows = report.prdAlignment.findings.map((f) => findingRow(f, t, policy, showSource));
  const scenarioBlocks = report.scenarios.map((s) => scenarioBlock(s, t, policy));

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

  const compose = (scenarioCount: number, findingCount: number): string => {
    const lines = [...head];
    if (findingRows.length > 0) {
      lines.push(
        `### ${t.sections.alignment}`,
        '',
        `| ${t.table.requirement} | ${t.table.status} | ${t.table.evidence} |`,
        '| --- | --- | --- |',
        ...findingRows.slice(0, findingCount),
        '',
      );
      if (findingCount < findingRows.length) {
        lines.push(`> ${t.omittedFindings(findingRows.length - findingCount)}`, '');
      }
    }
    lines.push(`### ${t.sections.scenarios} (${scenarioBlocks.length})`, '');
    for (const block of scenarioBlocks.slice(0, scenarioCount)) lines.push(block, '');
    if (scenarioCount < scenarioBlocks.length) {
      lines.push(`> ${t.omittedScenarios(scenarioBlocks.length - scenarioCount)}`, '');
    }
    lines.push(...tail);
    return lines.join('\n');
  };

  // DLV-03: scenarios are already folded; when the comment is still too long, drop them from the
  // lowest priority upward (they are sorted P0 → P2), then requirement rows, then cut.
  let scenarioCount = scenarioBlocks.length;
  let findingCount = findingRows.length;
  let body = compose(scenarioCount, findingCount);
  while (body.length > opts.limit && scenarioCount > 0) body = compose(--scenarioCount, findingCount);
  while (body.length > opts.limit && findingCount > 0) body = compose(scenarioCount, --findingCount);
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
