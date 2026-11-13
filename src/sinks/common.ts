/**
 * Shared pieces of the Jira / GitHub Issue / Notion case sinks (SPEC v3 §4, §5).
 * Owner: qa-work-session-a.
 *
 * Every ticket the tool writes has two parts:
 * - the tool-owned area (title and the case body), rewritten on update;
 * - a hidden payload after it: the case as last written, `RenderedCase.hash`, and a digest of the
 *   tool-owned area in the sink's own format.
 * Anything people add after the payload (notes, links) is never rewritten.
 *
 * Why a sink digest next to `RenderedCase.hash`: Jira stores ADF and Notion stores blocks, and
 * both normalize what they store, so the Markdown hash cannot be recomputed from a ticket. The
 * digest is taken over the sink's own text form (ADF→MD, blocks→MD, Markdown) at write time and
 * again at read time; `currentHash` equals `writtenHash` while the digest still matches.
 */
import { createHash } from 'node:crypto';
import { isAbortError, isRateLimitError, statusOf } from '../context/retry';
import type { CaseSetSummary, ExistingCaseTicket, HumanFields, QaCase } from '../core/cases';
import type { Language } from '../core/contracts';
import { QtgError } from '../core/errors';

export const CASE_LABEL = 'qtg-case';
/** Ticket label (Jira/GitHub) or select value set by markObsolete, next to the title prefix. */
export const OBSOLETE_TICKET_LABEL = 'qtg-obsolete';
const PAYLOAD_VERSION = 1;

/** Digest of the tool-owned area, split so a tool-made title change keeps body edits visible. */
export interface AreaDigest {
  title: string;
  body: string;
}

/** Hidden per-ticket record (§4.5). */
export interface SinkPayload {
  v: typeof PAYLOAD_VERSION;
  caseId: string;
  /** `RenderedCase.hash` of the last write (→ ExistingCaseTicket.writtenHash). */
  hash: string;
  digest: AreaDigest;
  case: QaCase;
}

export const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** Line endings and trailing spaces change when people re-save; they are not edits. */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim();
}

export function areaDigest(title: string, bodyText: string): AreaDigest {
  return { title: sha256(normalizeText(title)), body: sha256(normalizeText(bodyText)) };
}

/**
 * §4.5 — `currentHash` for ExistingCaseTicket: the written hash while the ticket still shows what
 * the tool wrote, otherwise a value that cannot equal any written hash.
 */
export function currentHashOf(payload: SinkPayload | null, now: AreaDigest): string {
  if (payload && payload.digest.title === now.title && payload.digest.body === now.body) return payload.hash;
  return `edited:${sha256(`${now.title}:${now.body}`)}`;
}

export function encodePayload(p: SinkPayload): string {
  return Buffer.from(JSON.stringify(p), 'utf8').toString('base64');
}

/** Decodes and shape-checks a payload; anything unexpected (or hand-edited) is null. */
export function decodePayload(text: string | undefined | null, caseId?: string): SinkPayload | null {
  if (!text) return null;
  try {
    const p = JSON.parse(Buffer.from(text.trim(), 'base64').toString('utf8')) as Partial<SinkPayload>;
    const ok =
      p.v === PAYLOAD_VERSION &&
      typeof p.caseId === 'string' &&
      typeof p.hash === 'string' &&
      typeof p.digest?.title === 'string' &&
      typeof p.digest?.body === 'string' &&
      typeof p.case === 'object' &&
      p.case !== null &&
      p.case.caseId === p.caseId &&
      (caseId === undefined || p.caseId === caseId);
    return ok ? (p as SinkPayload) : null;
  } catch {
    return null;
  }
}

export function ticketFrom(args: {
  caseId: string;
  ticketRef: string;
  url: string;
  payload: SinkPayload | null;
  now: AreaDigest;
  human: HumanFields;
}): ExistingCaseTicket {
  return {
    caseId: args.caseId,
    ticketRef: args.ticketRef,
    url: args.url,
    lastWritten: args.payload?.case ?? null,
    writtenHash: args.payload?.hash ?? null,
    currentHash: currentHashOf(args.payload, args.now),
    human: args.human,
  };
}

// ───────────────────────────── text ─────────────────────────────

/**
 * §4.4 — same labels and format as session b's renderCase (`[해당 없음][P0][경계값] …`, no space),
 * so a title the sink marks equals the one renderCase produces for an obsolete case.
 */
export const OBSOLETE_LABEL: Record<Language, string> = {
  en: 'Obsolete',
  ko: '해당 없음',
  ja: '対象外',
  'zh-CN': '不再适用',
};
const ALL_PREFIXES = Object.values(OBSOLETE_LABEL).map((l) => `[${l}]`);

export const isObsoleteTitle = (title: string): boolean => ALL_PREFIXES.some((p) => title.startsWith(p));

/** §4.4 — idempotent: an already marked title is not marked twice (in any language). */
export function obsoleteTitle(title: string, language: Language): string {
  return isObsoleteTitle(title) ? title : `[${OBSOLETE_LABEL[language]}]${title}`;
}

const SUMMARY_TEXT: Record<
  Language,
  { heading: string; total: (n: number) => string; obsolete: (n: number) => string; none: string }
> = {
  en: {
    heading: 'QA cases',
    total: (n) => `${n} active case(s)`,
    obsolete: (n) => `${n} obsolete`,
    none: 'No cases yet.',
  },
  ko: {
    heading: 'QA 케이스',
    total: (n) => `활성 케이스 ${n}건`,
    obsolete: (n) => `해당 없음 ${n}건`,
    none: '케이스 없음',
  },
  ja: {
    heading: 'QA ケース',
    total: (n) => `有効なケース ${n} 件`,
    obsolete: (n) => `対象外 ${n} 件`,
    none: 'ケースなし',
  },
  'zh-CN': {
    heading: 'QA 用例',
    total: (n) => `有效用例 ${n} 个`,
    obsolete: (n) => `不适用 ${n} 个`,
    none: '暂无用例',
  },
};

/** Marker that identifies the spec-side summary comment of one spec. */
export const summaryMarker = (specId: string): string => `qtg-summary:${specId}`;
/** Marker that identifies the tool's suggestion comment on one case ticket. */
export const suggestMarker = (caseId: string): string => `qtg-suggest:${caseId}`;

export interface SummaryLine {
  text: string;
  /** Link target or reference shown for the case (`#123`, a URL, …). */
  ref?: string;
  obsolete: boolean;
}

/** Plain lines of the spec-side summary; each sink formats them (Markdown checklist, ADF list). */
export function summaryLines(
  summary: CaseSetSummary,
  refFor: (url: string | undefined) => string | undefined,
) {
  const t = SUMMARY_TEXT[summary.language];
  const { byPriority } = summary.counts;
  const counts = [
    t.total(summary.counts.total),
    `P0 ${byPriority.P0} · P1 ${byPriority.P1} · P2 ${byPriority.P2}`,
    ...(summary.counts.obsolete > 0 ? [t.obsolete(summary.counts.obsolete)] : []),
  ].join(' · ');
  const order = { P0: 0, P1: 1, P2: 2 } as const;
  const lines: SummaryLine[] = [...summary.cases]
    .sort(
      (a, b) =>
        Number(a.lifecycle === 'obsolete') - Number(b.lifecycle === 'obsolete') ||
        order[a.priority] - order[b.priority] ||
        a.caseId.localeCompare(b.caseId),
    )
    .map((c) => ({
      text: `[${c.priority}] ${c.caseId} ${c.title}`,
      ref: refFor(c.url),
      obsolete: c.lifecycle === 'obsolete',
    }));
  return { heading: t.heading, counts, lines, empty: t.none };
}

// ───────────────────────────── errors ─────────────────────────────

/**
 * Turns an HTTP failure into a QtgError whose message is safe to show (no response bodies) and
 * says what to fix for 401/403/404. Aborts pass through unchanged.
 */
export function sinkError(err: unknown, sink: string, action: string): unknown {
  if (err instanceof QtgError || isAbortError(err)) return err;
  const status = statusOf(err);
  if (status === undefined) return err;
  if ((status === 401 || status === 403) && !isRateLimitError(err)) {
    return new QtgError(
      'config_invalid',
      `${sink}: permission denied while ${action} (HTTP ${status}). The token needs write access to the case tickets.`,
      { cause: err },
    );
  }
  if (status === 404) {
    return new QtgError(
      'config_invalid',
      `${sink}: not found while ${action} (HTTP 404). Check the project/database settings.`,
      {
        cause: err,
      },
    );
  }
  return new QtgError('internal', `${sink}: request failed while ${action} (HTTP ${status}).`, {
    cause: err,
  });
}
