/**
 * Verify phase (SPEC v3 §2.2): merge the model's per-case code statuses and its code-derived cases
 * into the case set. Pure and deterministic.
 *
 * - A status for an unknown caseId, for an obsolete case, with an invalid status value or repeating
 *   a caseId already judged is dropped with a warning.
 *   Valid statuses replace the case's codeStatus, stamped with the PR head `sha`.
 * - Active cases without a status keep their previous codeStatus.
 * - New cases get origin 'code' and ids after the highest existing number (`<specKey>-C<nn>`).
 *   A new case with the same title and technique as an existing code case is a duplicate: it is
 *   dropped, and an obsolete duplicate is revived instead (the risk is back in the code).
 * - Output order: the input cases in order, then the new cases in model order.
 */
import type { ApplyVerify, CaseDraft, CodeStatus, QaCase } from '../core/cases';
import type { Warning } from '../core/contracts';
import { caseIdFor, caseNumber, specKey, toQaCase } from './reconcile';
import { plainTitle } from './render';

const CODE_STATUSES: readonly CodeStatus[] = ['implemented', 'missing', 'contradicts', 'unknown'];

/** Duplicate key for code cases: normalised title + technique. */
function dupKey(c: Pick<CaseDraft, 'title' | 'technique'>): string {
  return `${c.technique}\u0000${plainTitle(c.title).toLowerCase()}`;
}

export const applyVerify: ApplyVerify = (cases, result, sha, specRef) => {
  const warnings: Warning[] = [];
  const warn = (message: string) => warnings.push({ code: 'other', message });

  const index = new Map<string, number>();
  cases.forEach((c, i) => {
    if (!index.has(c.caseId)) index.set(c.caseId, i);
  });
  const out = cases.map((c) => toQaCase(c, c.caseId, c.specRef, c.lifecycle, c.codeStatus));

  const judged = new Set<string>();
  for (const s of result.statuses) {
    const i = index.get(s.caseId);
    if (i === undefined) {
      warn(`Code status for unknown case ${s.caseId} was ignored.`);
      continue;
    }
    const c = out[i] as QaCase;
    if (c.lifecycle === 'obsolete') {
      warn(`Code status for obsolete case ${s.caseId} was ignored.`);
      continue;
    }
    if (!CODE_STATUSES.includes(s.status)) {
      warn(`Code status "${String(s.status)}" for case ${s.caseId} is not valid and was ignored.`);
      continue;
    }
    if (judged.has(s.caseId)) {
      warn(`Case ${s.caseId} was judged twice; the first status was kept.`);
      continue;
    }
    judged.add(s.caseId);
    out[i] = toQaCase(c, c.caseId, c.specRef, c.lifecycle, {
      status: s.status,
      evidence: s.evidence,
      files: s.files,
      sha,
    });
  }

  const key = specKey(specRef);
  let next = 0;
  for (const c of out) next = Math.max(next, caseNumber(key, c.caseId) ?? 0);

  const codeCases = new Map<string, number>();
  out.forEach((c, i) => {
    if (c.origin === 'code' && !codeCases.has(dupKey(c))) codeCases.set(dupKey(c), i);
  });

  for (const draft of result.newCases) {
    const k = dupKey(draft);
    const existing = codeCases.get(k);
    if (existing !== undefined) {
      const c = out[existing] as QaCase;
      if (c.lifecycle === 'obsolete') {
        out[existing] = { ...c, lifecycle: 'active' };
        warn(`Code case ${c.caseId} came back in this PR and is active again.`);
      }
      continue; // same risk already tracked
    }
    const c = toQaCase({ ...draft, origin: 'code' }, caseIdFor(key, ++next), specRef, 'active', undefined);
    codeCases.set(k, out.length);
    out.push(c);
  }
  return { cases: out, warnings };
};
