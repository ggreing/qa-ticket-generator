/**
 * PR summary for the verify phase (SPEC v3 §2.2, §6): what a reviewer needs from the top of the
 * comment, with links to the case tickets where the detail lives.
 *
 *   header: alignment badge, commit
 *   spec and case counts
 *   code status counts
 *   cases the code misses or contradicts   (links)
 *   P0 checklist, at most `max-scenarios`  (links)
 *   cases added from the code              (links)
 *   <details> requirement findings, all cases </details>
 *   footer
 *
 * Case text was written by the model and is sanitized like every other model text (DLV-06).
 * Ticket links come from the sinks; they are used only when they are plain https URLs.
 * Owner: qa-work-session-c(fable).
 */
import type { CodeStatus, Priority, QaCase } from '../../core/cases';
import type { Language, LlmUsage, PrdRef, PullRequestInfo, QaReport, Warning } from '../../core/contracts';
import { type LinkPolicy, mdCode, mdInline } from '../sanitize';
import { strings } from './i18n';
import {
  ALIGNMENT_BADGE,
  formatTokens,
  MAX_COMMENT_CHARS,
  REQUIREMENT_ICON,
  STATE_RESERVE,
} from './markdown';
import {
  lead,
  MAX_EVIDENCE_CHARS,
  MAX_EXPECTED_CHARS,
  MAX_REQUIREMENT_CHARS,
  shorten,
  splitRequirement,
} from './ticket';

/** A case with the link to its ticket, when a sink returned one. */
export type SummaryCase = QaCase & { url?: string };

/** What the verify-phase summary is rendered from. */
export interface VerifySummaryInput {
  pr: Pick<PullRequestInfo, 'number' | 'title' | 'htmlUrl' | 'owner' | 'repo'>;
  spec: { ref: PrdRef; title: string };
  language: Language;
  /** Commit the code statuses were judged at. */
  sha: string;
  alignment: QaReport['prdAlignment'];
  /** Every case of the spec after this run, obsolete ones included. */
  cases: SummaryCase[];
  /** Ids of the code-derived cases this run created. */
  newCaseIds: string[];
  /** `max-scenarios`: how many P0 cases the checklist shows (SPEC v3 §6). */
  maxChecklist: number;
  meta: {
    model: string;
    usage: LlmUsage;
    costUsd: number;
    durationMs: number;
    calls: number;
    warnings: Warning[];
    dryRun?: boolean;
  };
}

export const CODE_STATUS_ICON: Readonly<Record<CodeStatus, string>> = {
  implemented: '✅',
  missing: '❌',
  contradicts: '⛔',
  unknown: '❓',
};
/** Cases listed under "needs attention" before the rest is folded into "+N". */
export const MAX_ATTENTION_ITEMS = 20;
export const MAX_NEW_CASE_ITEMS = 10;
/** Which status comes first wherever cases are listed: what needs a developer, then what needs a tester. */
const STATUS_ORDER: Readonly<Record<CodeStatus | 'none', number>> = {
  contradicts: 0,
  missing: 1,
  unknown: 2,
  none: 3,
  implemented: 4,
};
const PRIORITY_ORDER: Readonly<Record<Priority, number>> = { P0: 0, P1: 1, P2: 2 };

interface VerifyStrings {
  spec: string;
  cases: (total: number, p0: number, p1: number, p2: number) => string;
  codeStatus: string;
  status: Record<CodeStatus, string>;
  notJudged: string;
  attention: (count: number) => string;
  noAttention: string;
  p0Checklist: (shown: number, total: number) => string;
  noP0: string;
  fromCode: (count: number) => string;
  allCases: (count: number) => string;
  obsolete: (count: number) => string;
  table: { id: string; priority: string; status: string; title: string };
  noCases: string;
}

const VERIFY_STRINGS: Readonly<Record<Language, VerifyStrings>> = {
  en: {
    spec: 'Spec',
    cases: (n, p0, p1, p2) => `${n} cases (P0 ${p0} · P1 ${p1} · P2 ${p2})`,
    codeStatus: 'Code status',
    status: {
      implemented: 'Implemented',
      missing: 'Possibly missing',
      contradicts: 'Contradicts the spec',
      unknown: 'Cannot tell from code',
    },
    notJudged: 'Not judged',
    attention: (n) => `Missing or contradicting (${n})`,
    noAttention: 'No case is missing or contradicted in this change',
    p0Checklist: (shown, total) =>
      shown < total ? `P0 checklist (${shown} of ${total})` : `P0 checklist (${total})`,
    noP0: 'No P0 cases',
    fromCode: (n) => `Added from the code (${n})`,
    allCases: (n) => `All cases (${n})`,
    obsolete: (n) => `${n} obsolete case(s) are not shown`,
    table: { id: 'Case', priority: 'Priority', status: 'Code status', title: 'Title' },
    noCases: 'This spec has no QA cases yet. Run the plan phase first.',
  },
  ko: {
    spec: '기획서',
    cases: (n, p0, p1, p2) => `케이스 ${n}건 (P0 ${p0} · P1 ${p1} · P2 ${p2})`,
    codeStatus: '코드 상태',
    status: {
      implemented: '구현 확인됨',
      missing: '미구현 의심',
      contradicts: '기획과 상충',
      unknown: '코드로 판단 불가',
    },
    notJudged: '미판정',
    attention: (n) => `미구현 의심·상충 (${n})`,
    noAttention: '이번 변경에서 미구현·상충 케이스 없음',
    p0Checklist: (shown, total) =>
      shown < total ? `P0 체크리스트 (${total}건 중 ${shown}건)` : `P0 체크리스트 (${total})`,
    noP0: 'P0 케이스 없음',
    fromCode: (n) => `코드에서 추가된 케이스 (${n})`,
    allCases: (n) => `전체 케이스 (${n})`,
    obsolete: (n) => `해당 없음 처리된 케이스 ${n}건은 표시하지 않음`,
    table: { id: '케이스', priority: '우선순위', status: '코드 상태', title: '제목' },
    noCases: '이 기획서에 QA 케이스가 아직 없습니다. 기획 단계를 먼저 실행하세요.',
  },
  ja: {
    spec: '仕様書',
    cases: (n, p0, p1, p2) => `ケース ${n} 件 (P0 ${p0} · P1 ${p1} · P2 ${p2})`,
    codeStatus: 'コード状態',
    status: {
      implemented: '実装確認済み',
      missing: '未実装の疑い',
      contradicts: '仕様と矛盾',
      unknown: 'コードから判断不可',
    },
    notJudged: '未判定',
    attention: (n) => `未実装の疑い・矛盾 (${n})`,
    noAttention: '今回の変更に未実装・矛盾のケースなし',
    p0Checklist: (shown, total) =>
      shown < total ? `P0 チェックリスト (${total} 件中 ${shown} 件)` : `P0 チェックリスト (${total})`,
    noP0: 'P0 ケースなし',
    fromCode: (n) => `コードから追加されたケース (${n})`,
    allCases: (n) => `全ケース (${n})`,
    obsolete: (n) => `対象外になったケース ${n} 件は表示しません`,
    table: { id: 'ケース', priority: '優先度', status: 'コード状態', title: 'タイトル' },
    noCases: 'この仕様書にはまだ QA ケースがありません。先に計画フェーズを実行してください。',
  },
  'zh-CN': {
    spec: '需求文档',
    cases: (n, p0, p1, p2) => `用例 ${n} 条 (P0 ${p0} · P1 ${p1} · P2 ${p2})`,
    codeStatus: '代码状态',
    status: {
      implemented: '已实现',
      missing: '疑似未实现',
      contradicts: '与需求冲突',
      unknown: '无法从代码判断',
    },
    notJudged: '未判定',
    attention: (n) => `疑似未实现或冲突 (${n})`,
    noAttention: '本次变更没有未实现或冲突的用例',
    p0Checklist: (shown, total) =>
      shown < total ? `P0 检查清单 (${total} 条中的 ${shown} 条)` : `P0 检查清单 (${total})`,
    noP0: '没有 P0 用例',
    fromCode: (n) => `根据代码新增的用例 (${n})`,
    allCases: (n) => `全部用例 (${n})`,
    obsolete: (n) => `已不适用的 ${n} 条用例未显示`,
    table: { id: '用例', priority: '优先级', status: '代码状态', title: '标题' },
    noCases: '该需求文档还没有 QA 用例。请先运行计划阶段。',
  },
};

/** The verify-summary strings for a language (exported for tests). */
export const verifyStrings = (language: Language): VerifyStrings =>
  VERIFY_STRINGS[language] ?? VERIFY_STRINGS.en;

const SAFE_URL = /^https:\/\/[^\s<>()[\]"'`|\\]+$/;
/** `[caseId](url)` when the sink gave a usable link, else the id as code. */
function caseLink(c: SummaryCase): string {
  const id = c.caseId.replace(/[^\w.-]/g, '');
  return c.url && SAFE_URL.test(c.url) ? `[${id}](${c.url})` : mdCode(id);
}

const statusOf = (c: SummaryCase): CodeStatus | 'none' => c.codeStatus?.status ?? 'none';
const byUrgency = (a: SummaryCase, b: SummaryCase): number =>
  STATUS_ORDER[statusOf(a)] - STATUS_ORDER[statusOf(b)] ||
  PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
  a.caseId.localeCompare(b.caseId);

function capped(lines: string[], max: number, more: (n: number) => string): string[] {
  return lines.length <= max ? lines : [...lines.slice(0, max), `- … ${more(lines.length - max)}`];
}

function specLine(input: VerifySummaryInput, v: VerifyStrings, policy: LinkPolicy): string {
  const { ref, title } = input.spec;
  const id = mdInline(ref.id, policy);
  const link = ref.url && SAFE_URL.test(ref.url) ? `[${id}](${ref.url})` : id;
  const active = input.cases.filter((c) => c.lifecycle === 'active');
  const count = (p: Priority): number => active.filter((c) => c.priority === p).length;
  return `> ${v.spec}: ${link} ${mdInline(title, policy)} · ${v.cases(active.length, count('P0'), count('P1'), count('P2'))}`;
}

function render(input: VerifySummaryInput, limit: number): string {
  const t = strings(input.language);
  const v = verifyStrings(input.language);
  // Model text may link only to the pull request's repository; ticket links are added by this module.
  const host = /^https:\/\/([^/]+)\//.exec(input.pr.htmlUrl)?.[1] ?? 'github.com';
  const policy: LinkPolicy = { allowed: [`${host}/${input.pr.owner}/${input.pr.repo}`.toLowerCase()] };
  const active = input.cases.filter((c) => c.lifecycle === 'active');
  const obsolete = input.cases.length - active.length;
  const sha = input.sha.slice(0, 7).replace(/[^0-9a-f]/gi, '');

  const head: string[] = [
    `## 🧪 ${t.title} — ${mdCode(sha)} · ${ALIGNMENT_BADGE[input.alignment.status]} **${t.alignmentStatus[input.alignment.status]}**`,
    '',
    specLine(input, v, policy),
    '',
  ];
  if (active.length === 0) {
    head.push(`ℹ️ ${v.noCases}`, '');
  } else {
    const counts = (['implemented', 'missing', 'contradicts', 'unknown'] as const).map(
      (s) => `${CODE_STATUS_ICON[s]} ${v.status[s]} ${active.filter((c) => statusOf(c) === s).length}`,
    );
    const notJudged = active.filter((c) => statusOf(c) === 'none').length;
    if (notJudged > 0) counts.push(`${v.notJudged} ${notJudged}`);
    head.push(`**${v.codeStatus}**: ${counts.join(' · ')}`, '');

    // ── what the code misses or contradicts ───────────────────────────────────
    const attention = active
      .filter((c) => statusOf(c) === 'contradicts' || statusOf(c) === 'missing')
      .sort(byUrgency);
    if (attention.length > 0) {
      head.push(`**${v.attention(attention.length)}**`);
      const lines = attention.map((c) => {
        const evidence = c.codeStatus?.evidence.trim()
          ? ` — ${mdInline(lead(c.codeStatus.evidence, MAX_EVIDENCE_CHARS), policy)}`
          : '';
        const file = c.codeStatus?.files[0]
          ? ` ${mdCode(c.codeStatus.files[0])}${c.codeStatus.files.length > 1 ? ` +${c.codeStatus.files.length - 1}` : ''}`
          : '';
        return `- ${CODE_STATUS_ICON[statusOf(c) as CodeStatus]} ${caseLink(c)} **${c.priority}** ${mdInline(c.title, policy)}${evidence}${file}`;
      });
      head.push(...capped(lines, MAX_ATTENTION_ITEMS, t.more), '');
    } else {
      head.push(`✅ **${v.noAttention}**`, '');
    }

    // ── P0 checklist ──────────────────────────────────────────────────────────
    const p0 = active.filter((c) => c.priority === 'P0').sort(byUrgency);
    if (p0.length > 0) {
      const shown = p0.slice(0, Math.max(1, input.maxChecklist));
      head.push(`**${v.p0Checklist(shown.length, p0.length)}**`);
      for (const c of shown) {
        const expected = shorten(c.expected[0] ?? '', MAX_EXPECTED_CHARS);
        const s = statusOf(c);
        head.push(
          `- [ ] ${caseLink(c)} ${mdInline(c.title, policy)}${expected ? ` → ${mdInline(expected, policy)}` : ''}${s === 'none' ? '' : ` ${CODE_STATUS_ICON[s]}`}`,
        );
      }
      head.push('');
    } else {
      head.push(`_${v.noP0}_`, '');
    }

    // ── cases this run added from the code ────────────────────────────────────
    const added = active.filter((c) => input.newCaseIds.includes(c.caseId)).sort(byUrgency);
    if (added.length > 0) {
      head.push(`**${v.fromCode(added.length)}**`);
      const lines = added.map((c) => {
        const why = c.whyEasyToMiss.trim()
          ? ` — ${mdInline(lead(c.whyEasyToMiss, MAX_EVIDENCE_CHARS), policy)}`
          : '';
        return `- ${caseLink(c)} **${c.priority}** ${mdInline(c.title, policy)}${why}`;
      });
      head.push(...capped(lines, MAX_NEW_CASE_ITEMS, t.more), '');
    }
  }

  // ── folded detail ───────────────────────────────────────────────────────────
  const findingRows = input.alignment.findings.map((f) => {
    const { label, text } = splitRequirement(f.requirement);
    const name = `${label ? `**${mdInline(label, policy)}** ` : ''}${mdInline(lead(text, MAX_REQUIREMENT_CHARS * 2), policy)}`;
    return `| ${name} | ${REQUIREMENT_ICON[f.status]} ${t.requirementStatus[f.status]} | ${mdInline(lead(f.evidence, MAX_EVIDENCE_CHARS * 2), policy)} |`;
  });
  const caseRows = [...active].sort(byUrgency).map((c) => {
    const s = statusOf(c);
    return `| ${caseLink(c)} | ${c.priority} | ${s === 'none' ? v.notJudged : `${CODE_STATUS_ICON[s]} ${v.status[s]}`} | ${mdInline(c.title, policy)} |`;
  });

  const tail: string[] = [];
  for (const w of input.meta.warnings) tail.push(`> ⚠️ ${mdInline(w.message, policy)}`);
  if (obsolete > 0) tail.push(`> ${v.obsolete(obsolete)}`);
  if (input.meta.dryRun) tail.push(`> ${t.dryRun}`);
  if (tail.length > 0) tail.push('');
  const { usage } = input.meta;
  tail.push(
    `<sub>${[
      mdCode(input.meta.model),
      t.footer.tokens(
        formatTokens(usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens),
        formatTokens(usage.outputTokens),
      ),
      t.footer.calls(input.meta.calls),
      `~$${input.meta.costUsd.toFixed(2)}`,
      `${Math.round(input.meta.durationMs / 1000)}s`,
    ].join(' · ')}</sub>`,
  );

  const compose = (findings: number, cases: number): string => {
    const lines = [...head];
    if (findingRows.length > 0 && findings > 0) {
      lines.push(
        `<details><summary>${t.requirementDetails(findingRows.length)}</summary>`,
        '',
        `| ${t.table.requirement} | ${t.table.status} | ${t.table.evidence} |`,
        '| --- | --- | --- |',
        ...findingRows.slice(0, findings),
        ...(findings < findingRows.length
          ? ['', `> ${t.omittedFindings(findingRows.length - findings)}`]
          : []),
        '',
        '</details>',
        '',
      );
    }
    if (caseRows.length > 0 && cases > 0) {
      lines.push(
        `<details><summary>${v.allCases(caseRows.length)}</summary>`,
        '',
        `| ${v.table.id} | ${v.table.priority} | ${v.table.status} | ${v.table.title} |`,
        '| --- | --- | --- | --- |',
        ...caseRows.slice(0, cases),
        ...(cases < caseRows.length ? ['', `> … ${t.more(caseRows.length - cases)}`] : []),
        '',
        '</details>',
        '',
      );
    }
    lines.push(...tail);
    return lines.join('\n');
  };

  // Too long: shorten the full case table first (the tickets hold it anyway), then the findings.
  let cases = caseRows.length;
  let findings = findingRows.length;
  let body = compose(findings, cases);
  while (body.length > limit && cases > 0) {
    cases = Math.max(0, cases - Math.max(1, Math.ceil(cases / 4)));
    body = compose(findings, cases);
  }
  while (body.length > limit && findings > 0) body = compose(--findings, cases);
  if (body.length <= limit) return body;
  const notice = `\n\n> ${t.truncated}`;
  const cut = body.slice(0, Math.max(0, limit - notice.length));
  const lastBreak = cut.lastIndexOf('\n');
  return `${lastBreak > 0 ? cut.slice(0, lastBreak) : cut}${notice}`;
}

/** The PR comment body of a verify run. Fits GitHub's comment limit with room for the marker and state block. */
export function renderVerifyComment(input: VerifySummaryInput): string {
  return render(input, MAX_COMMENT_CHARS - STATE_RESERVE);
}

/** The same summary for the Job Summary or the CLI, without a length cap. */
export function renderVerifySummaryMarkdown(input: VerifySummaryInput): string {
  return render(input, Number.POSITIVE_INFINITY);
}
