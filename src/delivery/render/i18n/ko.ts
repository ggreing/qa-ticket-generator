import type { Strings } from './types';

export const ko: Strings = {
  title: 'AI QA',
  alignmentStatus: { aligned: '일치', partial: '부분 일치', misaligned: '불일치', no_prd: 'PRD 없음' },
  noPrd: '연결된 PRD가 없습니다 — 코드만으로 추론한 시나리오입니다(신뢰도 낮음)',
  linked: '연결된 문서',
  actionNeeded: (n) => `조치 필요 (${n})`,
  allCovered: (n) => `조치 필요 없음 — 요구사항 ${n}개 모두 충족`,
  needsCheck: (n) => `확인 필요 (${n})`,
  p0Checklist: (n) => `P0 체크리스트 (${n})`,
  noP0: 'P0 시나리오 없음',
  more: (n) => `외 ${n}건`,
  card: { given: '전제', data: '데이터', steps: '단계', expected: '기대', related: '관련', why: '이유' },
  confidence: '신뢰도',
  level: { high: '높음', medium: '보통', low: '낮음' },
  otherTickets: (n) => `P1 · P2 티켓 (${n})`,
  requirementDetails: (n) => `요구사항별 판정 (${n})`,
  sections: {
    risks: '리스크',
    assumptions: '가정',
    notes: '참고',
    skippedFiles: '제외된 파일',
    redactions: '마스킹된 비밀값',
  },
  table: { requirement: '요구사항', status: '상태', evidence: '근거' },
  requirementStatus: { covered: '충족', missing: '누락', contradicts: '상충', unclear: '불명확' },
  omittedTickets: (n) =>
    `GitHub 코멘트 길이 제한 때문에 우선순위가 낮은 티켓 ${n}개를 생략했습니다. 전체 리포트는 워크플로의 Job Summary와 report.json에 있습니다.`,
  omittedFindings: (n) =>
    `GitHub 코멘트 길이 제한 때문에 요구사항 ${n}개 행을 생략했습니다. 전체 리포트는 워크플로의 Job Summary와 report.json에 있습니다.`,
  truncated:
    'GitHub 코멘트 길이 제한에 맞춰 내용을 잘랐습니다. 전체 리포트는 워크플로의 Job Summary와 report.json에 있습니다.',
  runFailed: '실행 실패',
  errorCode: '오류 코드',
  errorHint: {
    cost_cap:
      '예상 비용이 `max-cost-usd` 상한을 넘어 분석을 실행하지 않았습니다. 워크플로에서 `max-cost-usd`를 올리거나, `token-budget`을 낮춰 변경을 더 작은 단위로 나눠 분석하세요.',
  },
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
    tickets: '티켓',
    detailsInThread: '티켓 상세는 스레드에 있습니다.',
  },
};
