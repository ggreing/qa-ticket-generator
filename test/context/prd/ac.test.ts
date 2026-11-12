import { describe, expect, it } from 'vitest';
import { extractAcceptanceCriteria, extractListItems } from '../../../src/context/prd/ac';

describe('extractAcceptanceCriteria', () => {
  it('PRD-07 reads the list under an "Acceptance Criteria" heading', () => {
    const md = [
      '# Coupon',
      'Intro text.',
      '## Acceptance Criteria',
      '- A coupon applies once',
      '- Expired coupons are rejected',
      '## Out of scope',
      '- Gift cards',
    ].join('\n');
    expect(extractAcceptanceCriteria(md)).toEqual(['A coupon applies once', 'Expired coupons are rejected']);
  });

  it('PRD-07 recognizes "인수 조건" and "AC" headings, numbered lists and decorations', () => {
    expect(extractAcceptanceCriteria('### 인수 조건\n1. 쿠폰은 1회만 적용\n2) 만료 쿠폰 거부')).toEqual([
      '쿠폰은 1회만 적용',
      '만료 쿠폰 거부',
    ]);
    expect(extractAcceptanceCriteria('## ✅ AC\n* one\n+ two')).toEqual(['one', 'two']);
    expect(extractAcceptanceCriteria('## 3. Acceptance criteria (v2) ##\n- x')).toEqual(['x']);
    expect(extractAcceptanceCriteria('## 인수조건\n- y')).toEqual(['y']);
  });

  it('PRD-07 does not treat "ACL" or "AC1" headings as AC sections', () => {
    expect(extractAcceptanceCriteria('## ACL changes\n- role table\n## AC1: one\n- detail')).toEqual([]);
  });

  it('PRD-07 accepts bold-only and "Acceptance Criteria:" pseudo-headings', () => {
    expect(
      extractAcceptanceCriteria('**Acceptance Criteria**\n- bold one\n\nOther text\n- still listed'),
    ).toEqual(['bold one', 'still listed']);
    expect(extractAcceptanceCriteria('Acceptance Criteria:\n- colon one\n## Next\n- no')).toEqual([
      'colon one',
    ]);
  });

  it('PRD-07 keeps subsections of the AC heading and folds nested items into their parent', () => {
    const md = [
      '## Acceptance Criteria',
      '### Happy path',
      '- [ ] applies once',
      '  - even across devices',
      '    continuation line',
      '### Edge cases',
      '- [x] rejects expired',
      '# Appendix',
      '- not AC',
    ].join('\n');
    expect(extractAcceptanceCriteria(md)).toEqual([
      'applies once; even across devices continuation line',
      'rejects expired',
    ]);
  });

  it('PRD-07 falls back to checkbox items anywhere when there is no AC heading', () => {
    const md = ['# Tasks', '- [ ] first', '  - detail', '- plain bullet', '- [X] second', 'text'].join('\n');
    expect(extractAcceptanceCriteria(md)).toEqual(['first; detail', 'second']);
  });

  it('PRD-07 returns [] without AC heading or checkboxes, and ignores code blocks', () => {
    expect(extractAcceptanceCriteria('# Spec\n- just a bullet')).toEqual([]);
    expect(extractAcceptanceCriteria('')).toEqual([]);
    expect(
      extractAcceptanceCriteria('```\n## Acceptance Criteria\n- [ ] fake\n```\n~~~\n- [ ] also fake\n~~~'),
    ).toEqual([]);
  });

  it('PRD-07 dedupes repeated items and handles CRLF and tabs', () => {
    expect(extractAcceptanceCriteria('## AC\r\n- same\r\n- same\r\n\t- nested')).toEqual([
      'same',
      'same; nested',
    ]);
  });
});

describe('extractListItems', () => {
  it('PRD-07 takes every list item of a dedicated AC field', () => {
    expect(extractListItems('Intro\n- a\n- [ ] b\n1. c')).toEqual(['a', 'b', 'c']);
  });

  it('PRD-07 falls back to non-empty lines when the field has no list', () => {
    expect(extractListItems('## Title\nfirst line\n\nsecond line\n```\ncode\n```')).toEqual([
      'Title',
      'first line',
      'second line',
    ]);
  });
});
