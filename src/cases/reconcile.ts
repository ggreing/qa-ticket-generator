/**
 * §4.1 — case identity across runs. The model may claim an existing id (`reuseCaseId`); this code
 * decides. Pure and deterministic: the same inputs always give the same ids.
 */
import type { CaseDraft, ExistingCaseTicket, QaCase, ReconcileCases, Technique } from '../core/cases';
import { TECHNIQUES } from '../core/cases';
import type { Warning } from '../core/contracts';

const JIRA_KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
const GITHUB_REF = /^[^/\s]+\/([^#\s]+)#(\d+)$/;
const NOTION_ID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/**
 * Normalised spec key used in case ids: a Jira key as is (`PROJ-123`), `owner/repo#12` → `repo-12`,
 * a Notion page id → its first 8 hex characters. Anything else is reduced to `[A-Za-z0-9._-]`.
 */
export function specKey(specRef: string): string {
  const ref = specRef.trim();
  if (JIRA_KEY.test(ref)) return ref.toUpperCase();
  const gh = GITHUB_REF.exec(ref);
  if (gh) return `${gh[1]}-${gh[2]}`;
  if (NOTION_ID.test(ref)) return ref.replace(/-/g, '').slice(0, 8).toLowerCase();
  const cleaned = ref
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return cleaned || 'SPEC';
}

/** `<specKey>-C<nn>`, at least two digits. */
export function caseIdFor(key: string, n: number): string {
  return `${key}-C${String(n).padStart(2, '0')}`;
}

/** Sequence number of `id` when it belongs to `key` (`PROJ-1-C07` → 7), else null. */
export function caseNumber(key: string, id: string): number | null {
  if (!id.startsWith(`${key}-C`)) return null;
  const rest = id.slice(key.length + 2);
  return /^\d+$/.test(rest) ? Number(rest) : null;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Sort case ids by key, then numerically by sequence number. */
export function compareCaseIds(a: string, b: string): number {
  const ma = /^(.*)-C(\d+)$/.exec(a);
  const mb = /^(.*)-C(\d+)$/.exec(b);
  if (ma && mb && ma[1] === mb[1]) return Number(ma[2]) - Number(mb[2]) || cmp(a, b);
  return cmp(a, b);
}

const clean = (s: unknown): string => (typeof s === 'string' ? s.replace(/\r\n?/g, '\n').trim() : '');
const cleanList = (xs: unknown): string[] => (Array.isArray(xs) ? xs.map(clean).filter((x) => x !== '') : []);

function techniqueOf(t: unknown): Technique {
  return (TECHNIQUES as readonly string[]).includes(t as string) ? (t as Technique) : 'happy_path';
}

/**
 * Builds a QaCase from case content with exactly the tool-owned keys. Anything else on the input
 * (e.g. human fields that leaked into a ticket payload) is dropped here.
 */
export function toQaCase(
  draft: CaseDraft,
  caseId: string,
  specRef: string,
  lifecycle: QaCase['lifecycle'],
  codeStatus: QaCase['codeStatus'] | undefined,
): QaCase {
  const out: QaCase = {
    caseId,
    specRef,
    lifecycle,
    title: clean(draft.title),
    acLabels: [...new Set(cleanList(draft.acLabels))],
    technique: techniqueOf(draft.technique),
    priority: draft.priority === 'P0' || draft.priority === 'P2' ? draft.priority : 'P1',
    preconditions: cleanList(draft.preconditions),
    testData: cleanList(draft.testData),
    steps: cleanList(draft.steps),
    expected: cleanList(draft.expected),
    whyEasyToMiss: clean(draft.whyEasyToMiss),
    origin: draft.origin === 'code' ? 'code' : 'spec',
  };
  if (codeStatus) {
    out.codeStatus = {
      status: codeStatus.status,
      evidence: clean(codeStatus.evidence),
      files: cleanList(codeStatus.files),
      sha: clean(codeStatus.sha),
    };
  }
  return out;
}

/**
 * §4.1 — validates reused ids, assigns new ones, keeps cases the spec no longer produces as
 * `obsolete` (content as last written) and revives obsolete cases the model reuses.
 *
 * - A reused id must belong to an existing ticket and may be claimed by one planned case only
 *   (first claim wins, in planned order). Otherwise the case gets a new id and a warning.
 * - New ids continue after the highest existing number for this spec key.
 * - Output order: planned cases in planned order, then obsolete cases by id.
 */
export const reconcileCases: ReconcileCases = (specRef, existing, planned) => {
  const key = specKey(specRef);
  const warnings: Warning[] = [];

  // First ticket per id wins; duplicates are ignored for identity (planSync ignores them too).
  const byId = new Map<string, ExistingCaseTicket>();
  for (const t of existing) if (!byId.has(t.caseId)) byId.set(t.caseId, t);

  let next = 0;
  for (const id of byId.keys()) next = Math.max(next, caseNumber(key, id) ?? 0);
  const newId = (): string => caseIdFor(key, ++next);

  const claimed = new Set<string>();
  const cases: QaCase[] = [];
  for (const p of planned) {
    const want = typeof p.reuseCaseId === 'string' ? p.reuseCaseId.trim() : '';
    let id: string;
    let ticket: ExistingCaseTicket | undefined;
    if (want === '') {
      id = newId();
    } else if (!byId.has(want)) {
      id = newId();
      warnings.push({
        code: 'other',
        message: `Case id ${want} does not exist; the case was given the new id ${id}.`,
      });
    } else if (claimed.has(want)) {
      id = newId();
      warnings.push({
        code: 'other',
        message: `Case id ${want} was reused by two cases; the second one was given the new id ${id}.`,
      });
    } else {
      id = want;
      ticket = byId.get(want);
    }
    claimed.add(id);
    cases.push(toQaCase(p, id, specRef, 'active', ticket?.lastWritten?.codeStatus));
  }

  const obsolete: QaCase[] = [];
  for (const [id, t] of byId) {
    if (claimed.has(id)) continue;
    if (!t.lastWritten) {
      warnings.push({
        code: 'other',
        message: `Case ${id} has no readable content in its ticket; it is marked obsolete without changes.`,
      });
      continue;
    }
    obsolete.push(toQaCase(t.lastWritten, id, specRef, 'obsolete', t.lastWritten.codeStatus));
  }
  obsolete.sort((a, b) => compareCaseIds(a.caseId, b.caseId));
  return { cases: [...cases, ...obsolete], warnings };
};
