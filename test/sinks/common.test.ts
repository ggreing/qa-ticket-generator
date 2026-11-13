import { describe, expect, it } from 'vitest';
import type { CaseSetSummary } from '../../src/core/cases';
import { QtgError } from '../../src/core/errors';
import {
  areaDigest,
  currentHashOf,
  decodePayload,
  encodePayload,
  isObsoleteTitle,
  normalizeText,
  obsoleteTitle,
  type SinkPayload,
  sinkError,
  summaryLines,
} from '../../src/sinks/common';
import { baseCase } from './support';

const payload = (over: Partial<SinkPayload> = {}): SinkPayload => ({
  v: 1,
  caseId: 'PROJ-123-C07',
  hash: 'h1',
  digest: areaDigest('title', 'body'),
  case: baseCase(),
  ...over,
});

describe('payload', () => {
  it('§4.5 round-trips and rejects tampered, mismatched or foreign payloads', () => {
    const p = payload();
    expect(decodePayload(encodePayload(p), 'PROJ-123-C07')).toEqual(p);
    expect(decodePayload(encodePayload(p), 'PROJ-123-C08')).toBeNull();
    expect(decodePayload('not base64 json')).toBeNull();
    expect(decodePayload(Buffer.from('{"v":2}').toString('base64'))).toBeNull();
    expect(decodePayload(encodePayload({ ...p, case: { ...p.case, caseId: 'OTHER' } }))).toBeNull();
    expect(decodePayload(null)).toBeNull();
  });
});

describe('currentHashOf', () => {
  it('§4.5 equals the written hash while the digest matches, and differs after any edit', () => {
    const p = payload();
    expect(currentHashOf(p, areaDigest('title', 'body'))).toBe('h1');
    expect(currentHashOf(p, areaDigest('title', 'bodY'))).toMatch(/^edited:/);
    expect(currentHashOf(p, areaDigest('Title', 'body'))).toMatch(/^edited:/);
    expect(currentHashOf(null, areaDigest('title', 'body'))).toMatch(/^edited:/);
  });

  it('§4.5 ignores line endings and trailing spaces (re-saving is not editing)', () => {
    expect(areaDigest('t', 'a\r\nb  \n')).toEqual(areaDigest('t', 'a\nb'));
    expect(normalizeText('  x \r\n y\t\n\n')).toBe('x\n y');
  });
});

describe('obsoleteTitle', () => {
  it("§4.4 prefixes like session b's renderCase, per language, and only once", () => {
    expect(obsoleteTitle('[P0][경계값] 쿠폰', 'ko')).toBe('[해당 없음][P0][경계값] 쿠폰');
    expect(obsoleteTitle('[P0] coupon', 'en')).toBe('[Obsolete][P0] coupon');
    expect(obsoleteTitle('[P0] x', 'ja')).toBe('[対象外][P0] x');
    expect(obsoleteTitle('[P0] x', 'zh-CN')).toBe('[不再适用][P0] x');
    expect(obsoleteTitle('[해당 없음][P0] 쿠폰', 'en')).toBe('[해당 없음][P0] 쿠폰');
    expect(isObsoleteTitle('[Obsolete] x')).toBe(true);
    expect(isObsoleteTitle('[P0] x')).toBe(false);
  });
});

describe('summaryLines', () => {
  it('§5 orders active cases by priority, obsolete last, with counts', () => {
    const summary: CaseSetSummary = {
      specRef: { source: 'jira', id: 'PROJ-1', raw: 'PROJ-1' },
      specTitle: 'Coupons',
      language: 'en',
      cases: [
        { caseId: 'PROJ-1-C03', title: 'c3', priority: 'P2', lifecycle: 'active', url: 'u3' },
        { caseId: 'PROJ-1-C01', title: 'c1', priority: 'P0', lifecycle: 'obsolete' },
        { caseId: 'PROJ-1-C02', title: 'c2', priority: 'P0', lifecycle: 'active', url: 'u2' },
      ],
      counts: { total: 2, byPriority: { P0: 1, P1: 0, P2: 1 }, obsolete: 1 },
      meta: { model: 'm', costUsd: 0, mode: 'plan' },
    };
    const out = summaryLines(summary, (c) => (c.url ? `<${c.url}>` : undefined));
    expect(out.counts).toBe('2 active case(s) · P0 1 · P1 0 · P2 1 · 1 obsolete');
    expect(out.lines.map((l) => [l.text, l.ref, l.obsolete])).toEqual([
      ['[P0] PROJ-1-C02 c2', '<u2>', false],
      ['[P2] PROJ-1-C03 c3', '<u3>', false],
      ['[P0] PROJ-1-C01 c1', undefined, true],
    ]);
  });
});

describe('sinkError', () => {
  const http = (status: number, headers: Record<string, string> = {}) =>
    Object.assign(new Error('x'), { status, headers });

  it('§5 turns 401/403 into a clear permission message and 404 into a settings hint', () => {
    const e403 = sinkError(http(403), 'Jira sink', 'creating a sub-task') as QtgError;
    expect(e403).toBeInstanceOf(QtgError);
    expect(e403.code).toBe('config_invalid');
    expect(e403.userMessage).toBe(
      'Jira sink: permission denied while creating a sub-task (HTTP 403). The token needs write access to the case tickets.',
    );
    expect((sinkError(http(404), 'S', 'a') as QtgError).userMessage).toContain('HTTP 404');
    expect((sinkError(http(500), 'S', 'a') as QtgError).code).toBe('internal');
  });

  it('§5 leaves aborts, QtgErrors, rate limits and plain errors alone', () => {
    const abort = new DOMException('x', 'AbortError');
    expect(sinkError(abort, 'S', 'a')).toBe(abort);
    const q = new QtgError('internal', 'x');
    expect(sinkError(q, 'S', 'a')).toBe(q);
    const plain = new Error('boom');
    expect(sinkError(plain, 'S', 'a')).toBe(plain);
    expect((sinkError(http(403, { 'retry-after': '5' }), 'S', 'a') as QtgError).code).toBe('internal');
  });
});
