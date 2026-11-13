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
 * - Safety net for rephrasings (see ./similar): a new case whose title reduces to the same
 *   signature as an existing code case, an active spec case or an earlier new case, with the same
 *   technique, is dropped the same way, with a warning naming the case it repeats. So is a new case
 *   with the exact title of an active spec case. Obsolete spec cases are not compared: the spec
 *   dropped them, so the code-side risk gets its own case.
 * - Output order: the input cases in order, then the new cases in model order.
 */
import type { ApplyVerify, CaseDraft, CodeStatus, QaCase } from '../core/cases';
import type { Warning } from '../core/contracts';
import { caseIdFor, caseNumber, specKey, toQaCase } from './reconcile';
import { plainTitle } from './render';
import { sameRiskKey } from './similar';

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

  // Cases a new case is compared with: code cases (any lifecycle) and active spec cases.
  const exact = new Map<string, number>();
  const similar = new Map<string, number>();
  const track = (c: QaCase, i: number) => {
    if (c.origin !== 'code' && c.lifecycle !== 'active') return;
    if (!exact.has(dupKey(c))) exact.set(dupKey(c), i);
    const s = sameRiskKey(c);
    if (s !== null && !similar.has(s)) similar.set(s, i);
  };
  out.forEach(track);

  for (const draft of result.newCases) {
    const byTitle = exact.get(dupKey(draft));
    const s = sameRiskKey(draft);
    const match = byTitle ?? (s === null ? undefined : similar.get(s));
    if (match !== undefined) {
      const c = out[match] as QaCase;
      const title = plainTitle(draft.title);
      if (c.origin !== 'code') {
        warn(`New code case "${title}" repeats spec case ${c.caseId} "${c.title}"; it was not added.`);
      } else if (c.lifecycle === 'obsolete') {
        out[match] = { ...c, lifecycle: 'active' };
        const via = byTitle === undefined ? ` (proposed as "${title}")` : '';
        warn(`Code case ${c.caseId} came back in this PR and is active again${via}.`);
      } else if (byTitle === undefined) {
        warn(`New code case "${title}" repeats ${c.caseId} "${c.title}"; it was not added.`);
      }
      continue; // same risk already tracked
    }
    const c = toQaCase({ ...draft, origin: 'code' }, caseIdFor(key, ++next), specRef, 'active', undefined);
    track(c, out.length);
    out.push(c);
  }
  return { cases: out, warnings };
};
