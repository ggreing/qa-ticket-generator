/**
 * §4.2–§4.5 — what to do in one sink, given its tickets and the reconciled cases. Pure.
 *
 * Hash contract with the sinks (agreed with session a): `writtenHash` is the `RenderedCase.hash`
 * the tool last wrote; a sink reports `currentHash === writtenHash` while its own digest of the
 * ticket text is unchanged, and something else (`edited:<digest>`) once a person edited it.
 *
 * Rules for a ticket `t` and the next case `c` with the same caseId:
 * - no ticket: `create` when `c` is active; nothing for an obsolete case.
 * - `c` obsolete: `obsolete` unless the ticket is already obsolete (then `unchanged`).
 * - `c` active, ticket edited by a person (or no readable hash): `suggest`, except when the tool
 *   has nothing new to propose (same hash as last written and no revival) → `unchanged`.
 * - `c` active, not edited: `unchanged` when the rendered hash equals the last written one and the
 *   ticket is not being revived; otherwise `update`. Two tool-owned keys can change without the
 *   text: `specDigest` (never rendered) and `origin` (rendered only when there are no AC labels).
 *   When the case carries a digest that differs from the ticket's, or its origin differs, an
 *   unedited ticket gets an `update` (same text, new payload) so later runs read the right values.
 *   An edited ticket is left alone (`unchanged`): a payload-only change is not worth a suggestion.
 * - tickets no next case refers to: `obsolete` unless already obsolete.
 * - duplicate tickets for one caseId: the first in list order is used, the rest get no op.
 * Human-owned fields are never part of an op's case: cases are built from tool-owned keys only.
 */
import type { ExistingCaseTicket, PlanSync, QaCase, SyncOp } from '../core/cases';
import { compareCaseIds } from './reconcile';

const isObsolete = (t: ExistingCaseTicket): boolean => t.lastWritten?.lifecycle === 'obsolete';

function opFor(t: ExistingCaseTicket, c: QaCase, hash: () => string): SyncOp {
  if (c.lifecycle === 'obsolete') {
    return isObsolete(t) ? { op: 'unchanged', ticket: t, case: c } : { op: 'obsolete', ticket: t };
  }
  const reviving = isObsolete(t);
  const edited = t.writtenHash === null || t.currentHash !== t.writtenHash;
  const same = t.writtenHash !== null && hash() === t.writtenHash;
  if (same && !reviving) {
    const last = t.lastWritten;
    const digestMoved = c.specDigest !== undefined && c.specDigest !== last?.specDigest;
    const originMoved = last !== null && c.origin !== last.origin;
    return (digestMoved || originMoved) && !edited
      ? { op: 'update', ticket: t, case: c }
      : { op: 'unchanged', ticket: t, case: c };
  }
  return edited ? { op: 'suggest', ticket: t, case: c } : { op: 'update', ticket: t, case: c };
}

export const planSync: PlanSync = (existing, next, render) => {
  const tickets = new Map<string, ExistingCaseTicket>();
  for (const t of existing) if (!tickets.has(t.caseId)) tickets.set(t.caseId, t);

  const ops: SyncOp[] = [];
  const seen = new Set<string>();
  for (const c of next) {
    if (seen.has(c.caseId)) continue; // reconcile never repeats an id; be safe anyway
    seen.add(c.caseId);
    const t = tickets.get(c.caseId);
    if (!t) {
      if (c.lifecycle === 'active') ops.push({ op: 'create', case: c });
      continue;
    }
    let memo: string | undefined;
    ops.push(opFor(t, c, () => (memo ??= render(c).hash)));
  }

  const leftovers = [...tickets.values()]
    .filter((t) => !seen.has(t.caseId) && !isObsolete(t))
    .sort((a, b) => compareCaseIds(a.caseId, b.caseId));
  for (const t of leftovers) ops.push({ op: 'obsolete', ticket: t });
  return ops;
};
