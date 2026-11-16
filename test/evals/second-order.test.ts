/**
 * The fixed second-order lists behind spec-coverage recall (expected.json `secondOrder`): the
 * combinations a sheet should have that no acceptance criterion asks for outright. The list does
 * not move between rounds, so coverage can be compared across prompts. This file checks the data,
 * not the grader. Kinds follow docs/quality/PLAN_QUESTIONS.md.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVALS_ROOT, gradedCases } from './support';

const KINDS = [
  'who-else',
  'zero-empty-same',
  'per-what',
  'across-the-line',
  'and-then',
  'other-state',
  'exact-form',
] as const;
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CJK = /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
/** Words that state an expected result; the list names situations and leaves outcomes to the sheet. */
const OUTCOME =
  /\b(?:should|must|will|is (?:rejected|accepted|refused|allowed)|are (?:rejected|accepted|refused|allowed))\b/i;

const splits = JSON.parse(readFileSync(join(EVALS_ROOT, 'splits.json'), 'utf8')) as {
  dev: string[];
  test: string[];
};
const cases = gradedCases();
const withSpec = cases.filter((c) => c.prdDocuments.length > 0);
const itemsOf = (c: (typeof cases)[number]) => c.expected.secondOrder ?? [];

describe('eval dataset: second-order lists (fixed coverage target)', () => {
  it('every case with a spec, in both splits, lists 5 to 8 combinations; cases without a spec list none', () => {
    for (const c of cases) {
      const n = itemsOf(c).length;
      if (c.prdDocuments.length === 0) expect(n, c.id).toBe(0);
      else expect(n, c.id).toBeGreaterThanOrEqual(5);
      expect(n, c.id).toBeLessThanOrEqual(8);
    }
    const listed = new Set(withSpec.map((c) => c.id));
    expect(splits.dev.filter((id) => listed.has(id))).toHaveLength(14);
    expect(splits.test.filter((id) => listed.has(id))).toHaveLength(9);
  });

  it('ids are kebab-case, unique in their case and distinct from the must-cover scenario ids', () => {
    for (const c of withSpec) {
      const ids = itemsOf(c).map((s) => s.id);
      for (const id of ids) expect(id, `${c.id}/${id}`).toMatch(KEBAB);
      expect(new Set(ids).size, c.id).toBe(ids.length);
      const must = new Set(c.expected.mustScenarios.map((m) => m.id));
      for (const id of ids) expect(must.has(id), `${c.id}/${id}`).toBe(false);
    }
  });

  it('each risk is one English sentence naming a situation, not an expected result', () => {
    for (const c of withSpec) {
      const risks = itemsOf(c).map((s) => s.risk);
      expect(new Set(risks).size, c.id).toBe(risks.length);
      for (const s of itemsOf(c)) {
        const where = `${c.id}/${s.id}`;
        expect(s.risk, where).toMatch(/^[A-Z0-9"']/);
        expect(s.risk.endsWith('.'), where).toBe(true);
        expect(s.risk, where).not.toMatch(/\n/);
        expect(s.risk.length, where).toBeGreaterThanOrEqual(15);
        expect(s.risk.length, where).toBeLessThanOrEqual(200);
        // One sentence: no full stop followed by a new sentence (decimals like 0.005 are fine).
        expect(s.risk.slice(0, -1), where).not.toMatch(/[.!?]\s+[A-Z]/);
        expect(s.risk, where).not.toMatch(CJK);
        expect(s.risk, where).not.toMatch(OUTCOME);
      }
    }
  });

  it('why names the kind first; test-split items say they come from the spec alone', () => {
    for (const c of withSpec) {
      const kinds = new Set<string>();
      for (const s of itemsOf(c)) {
        const where = `${c.id}/${s.id}`;
        expect(s.why, where).toBeDefined();
        const kind = (s.why ?? '').split(/[;\s(]/)[0] ?? '';
        expect(KINDS as readonly string[], where).toContain(kind);
        kinds.add(kind);
        if (splits.test.includes(c.id)) expect(s.why, where).toMatch(/spec only$/);
      }
      // A list of one kind would measure one habit, not coverage.
      expect(kinds.size, c.id).toBeGreaterThanOrEqual(3);
    }
  });
});
