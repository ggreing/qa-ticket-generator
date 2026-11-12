import type { Strings } from './types';

export const ko: Strings = {
  title: 'AI QA 시나리오',
  alignment: 'PRD 정합성',
  alignmentStatus: { aligned: '일치', partial: '부분 일치', misaligned: '불일치', no_prd: 'PRD 없음' },
  noPrd: '연결된 PRD가 없습니다 — 코드만으로 추론한 시나리오입니다(신뢰도 낮음)',
  linked: '연결된 문서',
  sections: {
    alignment: 'PRD 정합성',
    scenarios: '시나리오',
    risks: '리스크',
    assumptions: '가정',
    notes: '참고',
    skippedFiles: '제외된 파일',
    redactions: '마스킹된 비밀값',
  },
  table: { requirement: '요구사항', status: '상태', evidence: '근거' },
  requirementStatus: { covered: '충족', missing: '누락', contradicts: '상충', unclear: '불명확' },
  scenarioType: { happy_path: '정상', edge_case: '엣지', negative: '예외', regression: '회귀' },
  level: { high: '높음', medium: '보통', low: '낮음' },
  related: '관련',
  why: '이유',
  confidence: '신뢰도',
  omittedScenarios: (n) =>
    `GitHub 코멘트 길이 제한 때문에 우선순위가 낮은 시나리오 ${n}개를 생략했습니다. 전체 리포트는 워크플로의 Job Summary와 report.json에 있습니다.`,
  omittedFindings: (n) =>
    `GitHub 코멘트 길이 제한 때문에 요구사항 ${n}개 행을 생략했습니다. 전체 리포트는 워크플로의 Job Summary와 report.json에 있습니다.`,
  truncated:
    'GitHub 코멘트 길이 제한에 맞춰 내용을 잘랐습니다. 전체 리포트는 워크플로의 Job Summary와 report.json에 있습니다.',
  runFailed: '실행 실패',
  errorCode: '오류 코드',
  noFiles:
    '분석할 로직 변경이 없습니다 — 변경 파일이 모두 필터링되었습니다(lock 파일, 자동 생성 코드, 바이너리 등).',
  skipped: '분석을 건너뛰었습니다',
  dryRun: '드라이런',
  footer: {
    tokens: (i, o) => `입력 ${i} / 출력 ${o} 토큰`,
    cache: (r, w) => `캐시 읽기 ${r}, 쓰기 ${w}`,
    calls: (n) => `LLM 호출 ${n}회`,
    filesSkipped: (n) => `파일 ${n}개 제외`,
    redactions: (n) => `비밀값 ${n}건 마스킹`,
  },
  skipReason: {
    noise: '노이즈',
    binary: '바이너리',
    too_large: '크기 초과',
    patch_missing: 'diff 없음',
    budget: '토큰 예산',
    cost_cap: '비용 상한',
  },
  slack: {
    openPr: 'PR 열기',
    viewReport: '전체 리포트 보기',
    scenarios: '시나리오',
    topRisks: '주요 리스크',
    findings: '확인이 필요한 요구사항',
    detailsInThread: '시나리오 상세는 스레드에 있습니다.',
  },
};
