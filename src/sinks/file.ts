/**
 * File case sink (SPEC v3 §5): `qa-cases.md` (people), `qa-cases.csv` (TestRail / spreadsheets) and
 * `qa-cases.json` (input for the next run, via `previous`). Files have no human-owned fields.
 *
 * The pipeline does not call the sink for `unchanged` cases, so the sink keeps every case it has
 * seen (from `list()` and from the ops) and writes all three files in `publishSummary`.
 * Owner: qa-work-session-b.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CODE_STATUS_LABELS,
  compareCaseIds,
  mdSafe,
  OBSOLETE_LABEL,
  PRIORITIES,
  plainTitle,
  renderCase,
  SECTION_LABELS,
  TECHNIQUE_LABELS,
  toQaCase,
} from '../cases';
import type {
  CaseSetSummary,
  CaseSink,
  ExistingCaseTicket,
  QaCase,
  RenderedCase,
  SinkContext,
} from '../core/cases';
import type { Language, PrdRef } from '../core/contracts';

export const FILE_NAMES = { markdown: 'qa-cases.md', csv: 'qa-cases.csv', json: 'qa-cases.json' } as const;

/** Format of `qa-cases.json`. */
export interface CasesFile {
  version: 1;
  spec: PrdRef;
  specTitle: string;
  language: Language;
  cases: { case: QaCase; hash: string }[];
}

interface FileLabels {
  heading: string;
  total: (n: number) => string;
  details: string;
  columns: { id: string; title: string; technique: string; ac: string; codeStatus: string };
}

const FILE_LABELS: Record<Language, FileLabels> = {
  ko: {
    heading: 'QA 케이스',
    total: (n) => `전체 ${n}건`,
    details: '케이스 상세',
    columns: { id: 'ID', title: '제목', technique: '기법', ac: 'AC', codeStatus: '코드 상태' },
  },
  en: {
    heading: 'QA cases',
    total: (n) => `${n} cases`,
    details: 'Case details',
    columns: { id: 'ID', title: 'Title', technique: 'Technique', ac: 'AC', codeStatus: 'Code status' },
  },
  ja: {
    heading: 'QAケース',
    total: (n) => `全${n}件`,
    details: 'ケース詳細',
    columns: { id: 'ID', title: 'タイトル', technique: '技法', ac: 'AC', codeStatus: 'コード状況' },
  },
  'zh-CN': {
    heading: 'QA用例',
    total: (n) => `共${n}条`,
    details: '用例详情',
    columns: { id: 'ID', title: '标题', technique: '方法', ac: 'AC', codeStatus: '代码状态' },
  },
};

/** TestRail-compatible header plus a few extra columns TestRail imports can map or ignore. */
export const CSV_COLUMNS = [
  'ID',
  'Title',
  'Section',
  'Priority',
  'Type',
  'Preconditions',
  'Test Data',
  'Steps',
  'Expected',
  'Refs',
  'Why Easy To Miss',
  'Lifecycle',
  'Code Status',
] as const;

const PRIORITY_RANK: Record<QaCase['priority'], number> = { P0: 0, P1: 1, P2: 2 };

/** Active cases by priority then id, obsolete cases last. */
export function orderCases(cases: QaCase[]): QaCase[] {
  return [...cases].sort(
    (a, b) =>
      Number(a.lifecycle === 'obsolete') - Number(b.lifecycle === 'obsolete') ||
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
      compareCaseIds(a.caseId, b.caseId),
  );
}

/** One CSV cell (RFC 4180), with spreadsheet formula injection neutralised. */
export function csvCell(value: string): string {
  let v = value.replace(/\r\n?/g, '\n');
  if (/^[=+@\t\r]/.test(v) || /^-(?!\d)/.test(v)) v = `'${v}`;
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function csvRow(c: QaCase, language: Language): string[] {
  const L = SECTION_LABELS[language];
  return [
    c.caseId,
    plainTitle(c.title),
    c.acLabels.length > 0 ? c.acLabels.join(', ') : c.origin === 'code' ? L.codeOrigin : '',
    c.priority,
    TECHNIQUE_LABELS[language][c.technique],
    c.preconditions.join('\n'),
    c.testData.join('\n'),
    c.steps.map((s, i) => `${i + 1}. ${s.replace(/^\s*(?:\d+[.)]|[-*•])\s+/, '')}`).join('\n'),
    c.expected.join('\n'),
    c.specRef,
    c.whyEasyToMiss,
    c.lifecycle,
    c.codeStatus ? CODE_STATUS_LABELS[language][c.codeStatus.status] : '',
  ];
}

/** `qa-cases.csv`: UTF-8 with BOM (Excel opens Korean text correctly) and CRLF line ends. */
export function renderCsv(cases: QaCase[], language: Language): string {
  const lines = [
    CSV_COLUMNS.join(','),
    ...orderCases(cases).map((c) => csvRow(c, language).map(csvCell).join(',')),
  ];
  return `\ufeff${lines.join('\r\n')}\r\n`;
}

function tableRow(c: QaCase, language: Language): string {
  const L = SECTION_LABELS[language];
  const ac =
    c.acLabels.length > 0 ? c.acLabels.map(mdSafe).join(', ') : c.origin === 'code' ? L.codeOrigin : '';
  const status = c.codeStatus ? CODE_STATUS_LABELS[language][c.codeStatus.status] : '';
  return `| ${c.caseId} | ${mdSafe(plainTitle(c.title))} | ${TECHNIQUE_LABELS[language][c.technique]} | ${ac} | ${status} |`;
}

/** `qa-cases.md`: counts, one table per priority (obsolete last), then every case in full. */
export function renderMarkdownFile(file: Omit<CasesFile, 'version'>): string {
  const { language } = file;
  const F = FILE_LABELS[language];
  const cases = orderCases(file.cases.map((x) => x.case));
  const active = cases.filter((c) => c.lifecycle === 'active');
  const obsolete = cases.filter((c) => c.lifecycle === 'obsolete');
  const counts = PRIORITIES.map((p) => `${p} ${active.filter((c) => c.priority === p).length}`);
  if (obsolete.length > 0) counts.push(`${OBSOLETE_LABEL[language]} ${obsolete.length}`);

  const out: string[] = [
    `# ${F.heading}: ${mdSafe(file.specTitle)} (${mdSafe(file.spec.raw || file.spec.id)})`,
    '',
    `${F.total(cases.length)} · ${counts.join(' · ')}`,
  ];
  const header = `| ${F.columns.id} | ${F.columns.title} | ${F.columns.technique} | ${F.columns.ac} | ${F.columns.codeStatus} |`;
  const groups: [string, QaCase[]][] = [
    ...PRIORITIES.map((p): [string, QaCase[]] => [p, active.filter((c) => c.priority === p)]),
    [OBSOLETE_LABEL[language], obsolete],
  ];
  for (const [label, list] of groups) {
    if (list.length === 0) continue;
    out.push(
      '',
      `## ${label}`,
      '',
      header,
      '| --- | --- | --- | --- | --- |',
      ...list.map((c) => tableRow(c, language)),
    );
  }
  if (cases.length > 0) {
    out.push('', `## ${F.details}`);
    for (const c of cases) {
      const r = renderCase(c, language);
      out.push('', `### ${c.caseId} ${mdSafe(r.title)}`, '', r.markdown.replace(/^### /gm, '#### '));
    }
  }
  return `${out.join('\n')}\n`;
}

function parseCasesFile(text: string): CasesFile | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const f = data as Partial<CasesFile> | null;
  if (f?.version !== 1 || !Array.isArray(f.cases) || typeof f.spec?.id !== 'string') return null;
  const cases: CasesFile['cases'] = [];
  for (const entry of f.cases) {
    const c = entry?.case;
    if (!c || typeof c.caseId !== 'string' || typeof entry.hash !== 'string') continue;
    const lifecycle = c.lifecycle === 'obsolete' ? 'obsolete' : 'active';
    cases.push({
      case: toQaCase(c, c.caseId, String(c.specRef ?? f.spec.id), lifecycle, c.codeStatus),
      hash: entry.hash,
    });
  }
  return {
    version: 1,
    spec: f.spec,
    specTitle: typeof f.specTitle === 'string' ? f.specTitle : '',
    language: (f.language ?? 'en') as Language,
    cases,
  };
}

/** §5 — the file sink. `previous` is the `qa-cases.json` of an earlier run, or null. */
export function createFileCaseSink(
  options: { dir: string; previous: string | null },
  ctx: SinkContext,
): CaseSink {
  const stored = new Map<string, { case: QaCase; hash: string }>();
  // Normalised through toQaCase: tool-owned keys only, in a fixed order, so files are byte-stable.
  const put = (c: QaCase, hash: string) =>
    stored.set(c.caseId, { case: toQaCase(c, c.caseId, c.specRef, c.lifecycle, c.codeStatus), hash });

  return {
    kind: 'file',

    isConfigured: () => true,

    async list(spec: PrdRef): Promise<ExistingCaseTicket[]> {
      if (!options.previous) return [];
      let text: string;
      try {
        text = readFileSync(options.previous, 'utf8');
      } catch {
        ctx.logger.warn(`file sink: previous case file not found (${FILE_NAMES.json}); starting a new set.`);
        return [];
      }
      const file = parseCasesFile(text.replace(/^\ufeff/, ''));
      if (!file) {
        ctx.logger.warn(`file sink: previous ${FILE_NAMES.json} is not readable; starting a new set.`);
        return [];
      }
      const tickets: ExistingCaseTicket[] = [];
      for (const { case: c, hash } of file.cases) {
        if (c.specRef !== spec.id) continue;
        put(c, hash);
        tickets.push({
          caseId: c.caseId,
          ticketRef: c.caseId,
          url: '',
          lastWritten: c,
          writtenHash: hash,
          currentHash: hash,
          human: {},
        });
      }
      return tickets.sort((a, b) => compareCaseIds(a.caseId, b.caseId));
    },

    async create(_spec: PrdRef, c: QaCase, r: RenderedCase) {
      put(c, r.hash);
      return { ticketRef: c.caseId, url: '' };
    },

    async update(_t: ExistingCaseTicket, c: QaCase, r: RenderedCase) {
      put(c, r.hash);
    },

    // A file has no human edits; a "suggestion" (unreadable earlier entry) simply rewrites it.
    async suggest(_t: ExistingCaseTicket, c: QaCase, r: RenderedCase) {
      put(c, r.hash);
    },

    async markObsolete(t: ExistingCaseTicket) {
      const base = stored.get(t.caseId)?.case ?? t.lastWritten;
      if (!base) return;
      const c: QaCase = { ...base, lifecycle: 'obsolete' };
      put(c, renderCase(c, ctx.language).hash);
    },

    async publishSummary(spec: PrdRef, summary: CaseSetSummary) {
      const cases = [...stored.values()]
        .filter((x) => x.case.specRef === spec.id)
        .sort((a, b) => compareCaseIds(a.case.caseId, b.case.caseId));
      const file: CasesFile = {
        version: 1,
        spec,
        specTitle: summary.specTitle,
        language: ctx.language,
        cases,
      };
      mkdirSync(options.dir, { recursive: true });
      writeFileSync(join(options.dir, FILE_NAMES.json), `${JSON.stringify(file, null, 2)}\n`, 'utf8');
      writeFileSync(
        join(options.dir, FILE_NAMES.csv),
        renderCsv(
          cases.map((x) => x.case),
          ctx.language,
        ),
        'utf8',
      );
      writeFileSync(join(options.dir, FILE_NAMES.markdown), renderMarkdownFile(file), 'utf8');
      return {};
    },
  };
}
