/**
 * Human review for the v3 plan eval: a blind rating pack built from a plan results file, and a
 * comparison of the filled-in ratings with the rubric v3 judge. Both are offline.
 *
 * The pack shows each sampled sheet the way its tickets will read (rendered by the cases module)
 * and asks for the eight rubric criteria plus the one question the product exists for: is a case
 * missing. It never contains judge scores, expected answers or deterministic grades.
 * Owner: qa-work-session-c(fable).
 */
import { join } from 'node:path';
import { renderCase } from '../../src/cases';
import type { QaCase } from '../../src/core/cases';
import type { Language } from '../../src/core/contracts';
import { requirementsOf } from '../../src/llm/prompts/plan';
import type { EvalCase } from '../schema';
import {
  CASE_CRITERIA,
  type CaseCriterion,
  type CriterionV3,
  RUBRIC_V3,
  SHEET_CRITERIA,
  type SheetCriterion,
  sampleCases,
} from './rubric';
import type { PlanResults, PlanRun, V3Deps } from './run';

/** Cases per sheet a person is asked to score one by one. The whole sheet is shown for reading. */
export const CASES_TO_RATE = 8;
/** RUBRIC.md: above this mean disagreement the judge or the rubric needs work first. */
export const CALIBRATION_LIMIT_V3 = 0.5;

type Slot = number | null;

/** Criterion names and anchors in the reviewer's language, where a translation exists. */
const LOCAL_RUBRIC: Partial<
  Record<Language, Record<CriterionV3, { name: string; anchors: [string, string, string] }>>
> = {
  ko: {
    actionability: {
      name: '실행 가능성',
      anchors: [
        '모호해서 실행 불가',
        '실행은 되나 데이터나 구체적 기대 결과 부족',
        '전제·데이터·단계·기대 결과가 묻지 않고 실행할 만큼 구체적',
      ],
    },
    traceability: {
      name: '근거 연결',
      anchors: [
        '요구사항 인용 없음, 또는 케이스와 무관한 요구사항 인용',
        '인용한 요구사항과 느슨하게만 연결',
        '검증하는 요구사항을 인용하고, 그 요구사항의 내용이나 빈틈에서 도출됨',
      ],
    },
    priority: {
      name: '우선순위',
      anchors: [
        'P0와 P2가 뒤바뀜',
        '한 단계 어긋남',
        '업무 영향과 일치(P0 = 데이터 손실·금전·보안·핵심 흐름)',
      ],
    },
    missValue: {
      name: '놓치기 쉬운 케이스 가치',
      anchors: [
        '이 기획서의 실제 케이스가 아니거나 다른 케이스의 반복',
        '기획서에 명시된 케이스. 필요하지만 누구나 쓸 케이스',
        '기획서만 본 사람이 놓쳤을 법하고, 실패하면 문제가 되는 케이스',
      ],
    },
    style: {
      name: 'QA 목록다운 문체',
      anchors: ['설명조·설득조, AI 상투어', '일부 설명조', '현업 QA 시트와 구분이 안 됨'],
    },
    coverage: {
      name: '기획 커버리지',
      anchors: [
        '해당하는 요구사항×기법 조합 3개 이상에 케이스 없음',
        '그런 조합 1~2개에 케이스 없음',
        '모든 요구사항의 해당 기법마다 케이스 있음',
      ],
    },
    noDuplicates: {
      name: '중복 없음',
      anchors: [
        '같은 테스트 의도의 케이스가 여럿',
        '중복 1~2건',
        '같은 것을 검증하는 케이스 없음(분량 자체는 감점 아님)',
      ],
    },
    honesty: {
      name: '정직성',
      anchors: [
        '기획서에 없는 기능을 테스트하거나, 정의되지 않은 동작을 사실처럼 적음',
        '기획서 범위 안이지만 열린 결과 일부를 사실처럼 적음',
        '기획서 범위 안이고, 기획서가 침묵한 곳마다 확인할 질문을 적음',
      ],
    },
  },
};

const QUESTIONS: Record<'missed' | 'style', Partial<Record<Language, string>> & { en: string }> = {
  missed: {
    en: 'Is a case missing? List every case you would have written that is not in the sheet.',
    ko: '놓친 케이스가 있는가? 시트에 없는데 본인이라면 썼을 케이스를 모두 적어 주세요.',
  },
  style: {
    en: 'Does it read like a real QA sheet? Quote any line that sounds like an AI wrote it.',
    ko: 'QA 목록답게 읽히는가? AI가 쓴 것처럼 들리는 줄이 있으면 그대로 옮겨 적어 주세요.',
  },
};

export interface ReviewSampleV3 {
  sampleId: string;
  caseId: string;
  spec: { id: string; title: string; requirements: string[]; body: string };
  /** The whole sheet as its tickets will read, for the reviewer to go through. */
  sheetMarkdown: string;
  caseCount: number;
  ratings: {
    /** Score each 0, 1 or 2. */
    cases: { caseId: string; title: string; scores: Record<CaseCriterion, Slot> }[];
    sheet: Record<SheetCriterion, Slot>;
    /** Cases the reviewer would have written that the sheet lacks, one per entry. */
    missedCases: string[];
    /** Lines that read as AI-written, quoted. */
    aiSoundingLines: string[];
    notes: string;
  };
}

export interface ReviewPackV3 {
  version: 3;
  kind: 'plan';
  source: string;
  promptVersion: string;
  language: string;
  variant: string;
  rubric: Record<CriterionV3, { name: string; level: 'case' | 'sheet'; anchors: readonly string[] }>;
  questions: { missed: string; style: string };
  samples: ReviewSampleV3[];
}

/** The sheet as one Markdown document: an index, then every case as its ticket will read. */
export function renderSheetMarkdown(cases: QaCase[], language: Language): string {
  const active = cases.filter((c) => c.lifecycle === 'active');
  const rendered = active.map((c) => ({ c, r: renderCase(c, language) }));
  const index = rendered.map(({ c, r }) => `- \`${c.caseId}\` ${r.title}`).join('\n');
  const body = rendered
    .map(({ c, r }) => `### ${c.caseId} ${r.title}\n\n${r.markdown.trim()}`)
    .join('\n\n---\n\n');
  return `${index}\n\n---\n\n${body}\n`;
}

/** Picks `count` runs spread across the judge's scores (or across specs when nothing was judged). */
export function pickSheets(runs: PlanRun[], count: number): PlanRun[] {
  const sorted = [...runs].sort(
    (a, b) => (a.rubric?.overall ?? 0) - (b.rubric?.overall ?? 0) || a.caseId.localeCompare(b.caseId),
  );
  if (sorted.length <= count) return sorted;
  const picked = new Set<number>();
  for (let i = 0; i < count; i++) picked.add(Math.round((i * (sorted.length - 1)) / (count - 1 || 1)));
  return [...picked].sort((a, b) => a - b).map((i) => sorted[i] as PlanRun);
}

function readPlan(path: string, deps: V3Deps): PlanResults | null {
  try {
    const r = JSON.parse(deps.readFile(path)) as PlanResults;
    return r.kind === 'plan' && Array.isArray(r.runs) ? r : null;
  } catch {
    return null;
  }
}

/** `plan --review-pack <plan-results.json> [--sample n] [--out path]`. No API call. */
export function buildReviewPackV3(
  path: string,
  cases: EvalCase[],
  sample: number,
  out: string | null,
  deps: V3Deps,
): number {
  const results = readPlan(path, deps);
  if (!results) {
    deps.print(`Cannot build a review pack: ${path} is not a readable plan results file.`);
    return 2;
  }
  const byId = new Map(cases.map((c) => [c.id, c]));
  const usable = results.runs.filter((r) => byId.has(r.caseId) && r.cases.length > 0);
  if (usable.length === 0) {
    deps.print('Cannot build a review pack: the results file has no sheet for the current cases.');
    return 2;
  }
  const language = results.language as Language;
  const local = LOCAL_RUBRIC[language];
  const rubric = {} as ReviewPackV3['rubric'];
  for (const c of CASE_CRITERIA)
    rubric[c] = {
      name: local?.[c].name ?? RUBRIC_V3[c].name,
      level: 'case',
      anchors: local?.[c].anchors ?? RUBRIC_V3[c].anchors,
    };
  for (const c of SHEET_CRITERIA)
    rubric[c] = {
      name: local?.[c].name ?? RUBRIC_V3[c].name,
      level: 'sheet',
      anchors: local?.[c].anchors ?? RUBRIC_V3[c].anchors,
    };

  const samples = pickSheets(usable, sample).map((run): ReviewSampleV3 => {
    const spec = (byId.get(run.caseId) as EvalCase).prdDocuments[0];
    const requirements = spec
      ? requirementsOf(spec).map((r) => (r.text ? `${r.label}: ${r.text}` : r.label))
      : [];
    return {
      sampleId: run.caseId,
      caseId: run.caseId,
      spec: {
        id: spec?.ref.id ?? '',
        title: spec?.title ?? '',
        requirements,
        body: spec?.bodyMarkdown ?? '',
      },
      sheetMarkdown: renderSheetMarkdown(run.cases, language),
      caseCount: run.cases.length,
      ratings: {
        cases: sampleCases(run.cases, CASES_TO_RATE).map((c) => ({
          caseId: c.caseId,
          title: c.title,
          scores: { actionability: null, traceability: null, priority: null, missValue: null, style: null },
        })),
        sheet: { coverage: null, noDuplicates: null, honesty: null },
        missedCases: [],
        aiSoundingLines: [],
        notes: '',
      },
    };
  });
  const pack: ReviewPackV3 = {
    version: 3,
    kind: 'plan',
    source: path,
    promptVersion: results.promptVersion,
    language: results.language,
    variant: `${results.model} · ${results.effort}`,
    rubric,
    questions: {
      missed: QUESTIONS.missed[language] ?? QUESTIONS.missed.en,
      style: QUESTIONS.style[language] ?? QUESTIONS.style.en,
    },
    samples,
  };
  const target = out ?? join(deps.resultsRoot, 'review-pack-v3.json');
  deps.writeFile(target, `${JSON.stringify(pack, null, 2)}\n`);
  deps.print(
    `Review pack with ${samples.length} sheet(s) (language ${pack.language}, ${samples.reduce((n, s) => n + s.caseCount, 0)} cases to read, ${samples.reduce((n, s) => n + s.ratings.cases.length, 0)} to score) written to ${target}. It holds no judge scores and no expected answers.`,
  );
  return 0;
}

export interface CalibrationRowV3 {
  criterion: CriterionV3;
  pairs: number;
  human: number;
  judge: number;
  meanDiff: number;
  meanAbsDiff: number;
}

const mean = (values: number[]): number =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

/** Pairs each human score with the judge's score for the same sheet (and case). */
export function compareRatingsV3(pack: ReviewPackV3, results: PlanResults): CalibrationRowV3[] {
  const pairs = new Map<CriterionV3, [number, number][]>();
  const add = (c: CriterionV3, human: Slot | undefined, judge: number | undefined): void => {
    if (human == null || judge == null) return;
    pairs.set(c, [...(pairs.get(c) ?? []), [human, judge]]);
  };
  for (const sample of pack.samples) {
    const run = results.runs.find((r) => r.caseId === sample.caseId);
    if (!run?.rubric) continue;
    for (const rated of sample.ratings.cases) {
      const judged = run.rubric.cases.find((c) => c.id === rated.caseId);
      for (const c of CASE_CRITERIA) add(c, rated.scores[c], judged?.[c]);
    }
    for (const c of SHEET_CRITERIA) add(c, sample.ratings.sheet[c], run.rubric.sheet[c]);
  }
  return [...CASE_CRITERIA, ...SHEET_CRITERIA].map((criterion) => {
    const list = pairs.get(criterion) ?? [];
    return {
      criterion,
      pairs: list.length,
      human: mean(list.map(([h]) => h)),
      judge: mean(list.map(([, j]) => j)),
      meanDiff: mean(list.map(([h, j]) => j - h)),
      meanAbsDiff: mean(list.map(([h, j]) => Math.abs(j - h))),
    };
  });
}

/** `plan --calibrate <ratings.json> <plan-results.json>`. No API call. */
export function calibrateV3(ratingsPath: string, resultsPath: string, deps: V3Deps): number {
  let pack: ReviewPackV3;
  try {
    pack = JSON.parse(deps.readFile(ratingsPath)) as ReviewPackV3;
    if (pack.version !== 3 || !Array.isArray(pack.samples)) throw new Error('not a v3 pack');
  } catch {
    deps.print(`Cannot calibrate: ${ratingsPath} is not a readable v3 review pack.`);
    return 2;
  }
  const results = readPlan(resultsPath, deps);
  if (!results) {
    deps.print(`Cannot calibrate: ${resultsPath} is not a readable plan results file.`);
    return 2;
  }
  const rows = compareRatingsV3(pack, results);
  const rated = rows.filter((r) => r.pairs > 0);
  if (rated.length === 0) {
    deps.print('Cannot calibrate: no rating in the pack matches a judged sheet in the results file.');
    return 2;
  }
  deps.print(
    `Calibration of the rubric v3 judge against ${ratingsPath} (scores 0–2, language ${pack.language})`,
  );
  deps.print('');
  deps.print('| Criterion | Pairs | Human | Judge | Judge − human | Mean abs. diff |');
  deps.print('| --- | --- | --- | --- | --- | --- |');
  for (const r of rows) {
    const n =
      r.pairs === 0
        ? ['—', '—', '—', '—']
        : [r.human, r.judge, r.meanDiff, r.meanAbsDiff].map((x) => x.toFixed(2));
    deps.print(
      `| ${RUBRIC_V3[r.criterion].name} | ${r.pairs} | ${n[0]} | ${n[1]} | ${r.pairs > 0 && r.meanDiff > 0 ? '+' : ''}${n[2]} | ${n[3]} |`,
    );
  }
  // The question the product exists for, side by side: what the person missed vs what the judge listed.
  deps.print('');
  deps.print('| Sheet | Missing per reviewer | Missing per judge | AI-sounding lines quoted |');
  deps.print('| --- | --- | --- | --- |');
  for (const s of pack.samples) {
    const run = results.runs.find((r) => r.caseId === s.caseId);
    deps.print(
      `| ${s.caseId} | ${s.ratings.missedCases.length} | ${run?.rubric ? run.rubric.missingCases.length : '—'} | ${s.ratings.aiSoundingLines.length} |`,
    );
  }
  const overall = mean(rated.map((r) => r.meanAbsDiff));
  const off = rated
    .filter((r) => r.meanAbsDiff > CALIBRATION_LIMIT_V3)
    .map((r) => RUBRIC_V3[r.criterion].name);
  deps.print('');
  deps.print(
    `Mean absolute difference across criteria: ${overall.toFixed(2)} (limit ${CALIBRATION_LIMIT_V3}).`,
  );
  deps.print(
    overall > CALIBRATION_LIMIT_V3 || off.length > 0
      ? `The judge disagrees with the ratings${off.length > 0 ? ` on: ${off.join(', ')}` : ''}. Refine the judge prompt or the rubric before trusting its scores.`
      : 'The judge is within the limit on every rated criterion.',
  );
  return 0;
}
