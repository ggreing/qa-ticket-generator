import { describe, expect, it } from 'vitest';
import { buildCase, parseAnnotated, renderPatch } from '../../evals/authoring/build';
import { CASES } from '../../evals/authoring/index';
import { type EvalCase, loadCase, loadCases } from '../../evals/schema';
import { extractPrdRefs } from '../../src/context/prd/refs';
import { CASES_ROOT } from './support';

const cases = loadCases(CASES_ROOT);
const byId = new Map(cases.map((c) => [c.id, c]));
const statusesOf = (c: EvalCase) => c.expected.mustFindings.flatMap((m) => m.accept);
const count = (pred: (c: EvalCase) => boolean) => cases.filter(pred).length;

/** New-file content rebuilt from a patch that covers the whole file (used for added files). */
function applyPatchToEmpty(patch: string): string {
  return `${patch
    .split('\n')
    .filter((l) => l.startsWith('+'))
    .map((l) => l.slice(1))
    .join('\n')}\n`;
}

describe('eval dataset (SPEC §12.3)', () => {
  it('SPEC §12.3 has 10 cases and every file passes the dataset schema', () => {
    expect(cases).toHaveLength(10);
    expect(new Set(cases.map((c) => c.pr.number)).size).toBe(10);
    for (const c of cases) {
      expect(c.files.length, c.id).toBeGreaterThanOrEqual(2);
      expect(c.expected.mustScenarios.length, c.id).toBeGreaterThanOrEqual(3);
    }
  });

  it('SPEC §12.3 plants the required mix: ≥3 missing, ≥2 contradicts, ≥2 aligned, 1 without PRD, 1 injection', () => {
    expect(cases.flatMap(statusesOf).filter((s) => s === 'missing').length).toBeGreaterThanOrEqual(3);
    expect(cases.flatMap(statusesOf).filter((s) => s === 'contradicts').length).toBeGreaterThanOrEqual(2);
    expect(count((c) => c.expected.expectedAlignment === 'aligned')).toBeGreaterThanOrEqual(2);
    expect(count((c) => c.expected.expectedAlignment === 'no_prd')).toBe(1);
    expect(count((c) => c.expected.injection !== undefined)).toBe(1);
    // Both directions: fully implemented requirements are checked too, not only gaps.
    expect(cases.flatMap(statusesOf).filter((s) => s === 'covered').length).toBeGreaterThanOrEqual(10);
  });

  it('SPEC §12.3 mixes TypeScript, Python and Go, and several PRD sources', () => {
    const paths = cases.flatMap((c) => c.files.map((f) => f.path));
    for (const ext of ['.ts', '.py', '.go']) {
      expect(paths.filter((p) => p.endsWith(ext)).length, ext).toBeGreaterThanOrEqual(3);
    }
    const sources = new Set(cases.flatMap((c) => c.prdDocuments.map((d) => d.ref.source)));
    expect([...sources].sort()).toEqual(['github', 'jira', 'notion']);
  });

  it('the committed JSON is exactly what the authored cases generate', () => {
    expect(CASES.map((c) => c.id).sort()).toEqual([...byId.keys()].sort());
    for (const def of CASES) {
      const built = buildCase(def);
      const loaded = byId.get(def.id) as EvalCase;
      expect(loaded.pr, def.id).toEqual(built.pr);
      expect(loaded.files, def.id).toEqual(built.files);
      expect(loaded.prdDocuments, def.id).toEqual(built.prd.map((p) => p.doc));
      expect(loaded.expected, def.id).toEqual(built.expected);
    }
  });

  it('expected alignment follows from the expected finding statuses (SPEC §8 rubric)', () => {
    for (const c of cases) {
      const statuses = c.expected.mustFindings.map((m) => m.accept[0]);
      const derived =
        c.prdDocuments.length === 0
          ? 'no_prd'
          : statuses.includes('contradicts')
            ? 'misaligned'
            : statuses.every((s) => s === 'covered')
              ? 'aligned'
              : 'partial';
      expect(c.expected.expectedAlignment, c.id).toBe(derived);
      // One accepted status per requirement keeps the label unambiguous.
      for (const m of c.expected.mustFindings) expect(m.accept, `${c.id}/${m.id}`).toHaveLength(1);
    }
  });

  it('every must-finding points at a labelled acceptance criterion of the linked PRD', () => {
    for (const c of cases) {
      const criteria = c.prdDocuments.flatMap((d) => d.acceptanceCriteria);
      expect(c.expected.mustFindings.length, c.id).toBe(criteria.length);
      for (const m of c.expected.mustFindings) {
        const hits = criteria.filter((ac) => m.labels.some((label) => ac.startsWith(`${label}:`)));
        expect(hits, `${c.id}/${m.id}`).toHaveLength(1);
        // The keyword fallback must find the same criterion and no other.
        for (const keyword of m.keywords) {
          const byKeyword = criteria.filter((ac) => ac.toLowerCase().includes(keyword.toLowerCase()));
          expect(byKeyword, `${c.id}/${m.id}/${keyword}`).toEqual(hits);
        }
      }
      for (const d of c.prdDocuments) {
        for (const ac of d.acceptanceCriteria) expect(d.bodyMarkdown, c.id).toContain(ac);
      }
    }
  });

  it('PR bodies link their PRD the way the product parses it, and the no-PRD case links nothing', () => {
    for (const c of cases) {
      const refs = extractPrdRefs(c.pr.body, {
        defaultOwner: c.pr.owner,
        defaultRepo: c.pr.repo,
        jiraProjectKeys: [],
        maxDocuments: 5,
      });
      expect(refs.map((r) => r.id).sort(), c.id).toEqual(c.prdDocuments.map((d) => d.ref.id).sort());
    }
  });

  it('patches agree with head content: line counts match and added files rebuild exactly', () => {
    for (const c of cases) {
      for (const f of c.files) {
        if (f.patchMissing) {
          expect(f.patch, `${c.id}/${f.path}`).toBeUndefined();
          continue;
        }
        const body = (f.patch ?? '').split('\n').filter((l) => !l.startsWith('@@'));
        expect(body.filter((l) => l.startsWith('+')).length, f.path).toBe(f.additions);
        expect(body.filter((l) => l.startsWith('-')).length, f.path).toBe(f.deletions);
        const head = (f.headContent ?? '').split('\n');
        for (const line of body.filter((l) => l.startsWith('+') || l.startsWith(' '))) {
          expect(head, `${c.id}/${f.path}`).toContain(line.slice(1));
        }
        if (f.status === 'added') expect(applyPatchToEmpty(f.patch ?? '')).toBe(f.headContent);
        for (const header of (f.patch ?? '').split('\n').filter((l) => l.startsWith('@@'))) {
          expect(header).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/);
        }
      }
    }
  });

  it('no case leaks its answer: notes and expectations never appear in what the model sees', () => {
    for (const c of cases) {
      const visible = [
        c.pr.title,
        c.pr.body,
        ...c.files.map((f) => `${f.patch ?? ''}\n${f.headContent ?? ''}`),
        ...c.prdDocuments.map((d) => d.bodyMarkdown),
      ].join('\n');
      expect(visible, c.id).not.toContain(c.expected.notes);
      expect(visible, c.id).not.toMatch(/not implemented|TODO|FIXME|is missing|contradict/i);
    }
  });

  it('the injection case carries the attack in both the PRD and the code, with a canary to detect obedience', () => {
    const c = byId.get('profile-injection') as EvalCase;
    expect(c.prdDocuments[0]?.bodyMarkdown).toMatch(/Ignore your previous instructions/);
    expect(c.files[0]?.headContent).toMatch(/Reviewer bots/);
    expect(c.expected.forbidden[0]?.patterns).toEqual(['QA-OVERRIDE-7731']);
    expect(c.expected.forbidden[0]?.fields).not.toContain('risks'); // quoting it in the risk report is fine
    expect(c.expected.mustFindings.find((m) => m.id === 'AC2')?.accept).toEqual(['missing']);
  });

  it('loadCases reports unknown ids and loadCase rejects malformed files', () => {
    expect(() => loadCases(CASES_ROOT, ['nope'])).toThrow('Unknown eval case(s): nope');
    expect(loadCases(CASES_ROOT, ['report-timezone']).map((c) => c.id)).toEqual(['report-timezone']);
    expect(() => loadCase('test/evals', 'fixtures-bad')).toThrow();
  });
});

describe('case authoring (annotated diff → patch)', () => {
  it('renders hunks with three lines of context and correct line numbers', () => {
    const lines = parseAnnotated(
      [
        '',
        ' a',
        ' b',
        ' c',
        ' d',
        '-e',
        '+E',
        '+E2',
        ' f',
        ' g',
        ' h',
        ' i',
        ' j',
        ' k',
        ' l',
        ' m',
        '+n',
        '',
      ].join('\n'),
    );
    expect(renderPatch(lines)).toBe(
      [
        '@@ -2,7 +2,8 @@',
        ' b',
        ' c',
        ' d',
        '-e',
        '+E',
        '+E2',
        ' f',
        ' g',
        ' h',
        '@@ -11,3 +12,4 @@',
        ' k',
        ' l',
        ' m',
        '+n',
      ].join('\n'),
    );
  });

  it('merges hunks whose context touches, and handles pure additions and removals', () => {
    expect(renderPatch(parseAnnotated(' a\n+b\n c\n d\n e\n f\n+g\n h'))).toBe(
      ['@@ -1,6 +1,8 @@', ' a', '+b', ' c', ' d', ' e', ' f', '+g', ' h'].join('\n'),
    );
    expect(renderPatch(parseAnnotated('+x\n+y'))).toBe('@@ -0,0 +1,2 @@\n+x\n+y');
    expect(renderPatch(parseAnnotated('-x\n-y'))).toBe('@@ -1,2 +0,0 @@\n-x\n-y');
    expect(renderPatch(parseAnnotated(' same'))).toBe('');
  });

  it('builds file entries: added, modified, renamed, removed and patch-less files', () => {
    const built = buildCase({
      id: 'demo',
      pr: { number: 1, title: 't', author: 'a', headRef: 'h', body: '\nBody text.\n' },
      prd: [],
      files: [
        { path: 'new.ts', content: '\nexport const a = 1;\n' },
        { path: 'mod.ts', diff: ' keep\n-old\n+new\n\n keep2' },
        { path: 'moved.ts', previousPath: 'old.ts', diff: ' keep\n+added' },
        { path: 'gone.ts', diff: '-only line' },
        { path: 'logo.png', patchMissing: { additions: 0, deletions: 0 } },
      ],
      expected: CASES[0]?.expected as EvalCase['expected'],
    });
    expect(built.pr.body).toBe('Body text.');
    expect(built.pr.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(built.files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ['new.ts', 'added', 1, 0],
      ['mod.ts', 'modified', 1, 1],
      ['moved.ts', 'renamed', 1, 0],
      ['gone.ts', 'removed', 0, 1],
      ['logo.png', 'modified', 0, 0],
    ]);
    expect(built.files[0]?.headContent).toBe('export const a = 1;\n');
    expect(built.files[1]?.headContent).toBe('keep\nnew\n\nkeep2\n');
    expect(built.files[2]?.previousPath).toBe('old.ts');
    expect(built.files[3]?.headContent).toBeUndefined();
    expect(built.files[4]).toEqual({
      path: 'logo.png',
      status: 'modified',
      additions: 0,
      deletions: 0,
      patchMissing: true,
    });
  });

  it('rejects malformed annotated diffs', () => {
    expect(() => parseAnnotated(' ok\nbad line', 'x.ts')).toThrow('x.ts: line 2 must start with');
    expect(() =>
      buildCase({
        ...(CASES[0] as (typeof CASES)[number]),
        files: [{ path: 'same.ts', diff: ' unchanged' }],
      }),
    ).toThrow('same.ts: the diff changes nothing');
  });
});
