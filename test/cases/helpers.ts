/** Builders for case-engine tests and golden fixture sources. Synthetic data only. */
import { renderCase } from '../../src/cases';
import type { CaseDraft, ExistingCaseTicket, PlannedCase, QaCase } from '../../src/core/cases';
import type { Language } from '../../src/core/contracts';

export function draft(title: string, extra: Partial<CaseDraft> = {}): CaseDraft {
  return {
    title,
    acLabels: ['AC1'],
    technique: 'boundary',
    priority: 'P1',
    preconditions: ['로그인 상태'],
    testData: ['쿠폰 EXP1 / 만료 2026-11-13 23:59:59'],
    steps: ['결제 화면 진입', '쿠폰 EXP1 입력 후 적용'],
    expected: ['"만료된 쿠폰입니다" 토스트 노출', '결제 금액 변화 없음'],
    whyEasyToMiss: '기획서에 만료 시각 포함 여부 정의 없음',
    origin: 'spec',
    ...extra,
  };
}

export function planned(
  title: string,
  reuseCaseId: string | null = null,
  extra: Partial<CaseDraft> = {},
): PlannedCase {
  return { ...draft(title, extra), reuseCaseId };
}

export function qaCase(caseId: string, title: string, extra: Partial<QaCase> = {}): QaCase {
  return { ...draft(title), caseId, specRef: 'SHOP-101', lifecycle: 'active', ...extra };
}

/**
 * A ticket as a sink would report it. By default it holds exactly what the tool last wrote
 * (hash of `renderCase(lastWritten)`); `edited` simulates a person changing the ticket text.
 */
export function ticket(
  lastWritten: QaCase | null,
  opts: {
    caseId?: string;
    ticketRef?: string;
    language?: Language;
    edited?: boolean;
    writtenHash?: string | null;
    human?: ExistingCaseTicket['human'];
  } = {},
): ExistingCaseTicket {
  const caseId = opts.caseId ?? lastWritten?.caseId ?? 'UNKNOWN';
  const written =
    opts.writtenHash !== undefined
      ? opts.writtenHash
      : lastWritten
        ? renderCase(lastWritten, opts.language ?? 'ko').hash
        : null;
  return {
    caseId,
    ticketRef: opts.ticketRef ?? `T-${caseId}`,
    url: `https://tickets.example/${caseId}`,
    lastWritten,
    writtenHash: written,
    currentHash: opts.edited ? `edited:${caseId}` : (written ?? `digest:${caseId}`),
    human: opts.human ?? { execStatus: 'Pass', assignee: 'qa-lead' },
  };
}
