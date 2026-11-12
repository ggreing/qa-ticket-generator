import { describe, expect, it } from 'vitest';
import type { ReviewPack } from '../../evals/review';
import { compareWithLastKept, languageOf, languageSuffix, type RoundRecord } from '../../evals/rounds';
import { parseArgs, runEvals, type SavedResults, USAGE } from '../../evals/run';
import { fakeProvider, harness } from './harness';

type Harness = ReturnType<typeof harness>;
const CASES = ['--cases', 'coupon-expiry-missing,report-timezone'];
const records = (h: Harness): RoundRecord[] =>
  JSON.parse(h.files['evals/rounds/index.json'] as string) as RoundRecord[];
const sharing = (h: Harness) => ({ writeFile: h.deps.writeFile, readFile: h.deps.readFile });

describe('--language: the language reports are written in (M3.5 final check)', () => {
  it('M3.5 the default is English, and codes and the Action aliases are accepted', async () => {
    const plain = harness();
    await runEvals(CASES, plain.deps);
    expect(plain.out()).toContain('reps: 1   language: en');

    for (const [typed, language] of [
      ['ko', 'ko'],
      ['kr', 'ko'],
      ['KO', 'ko'],
      ['ja', 'ja'],
      ['jp', 'ja'],
      ['zh-CN', 'zh-CN'],
      ['zh', 'zh-CN'],
      ['en', 'en'],
    ]) {
      const h = harness();
      expect(await runEvals([...CASES, '--language', typed as string], h.deps), typed).toMatchObject({
        exitCode: 0,
      });
      expect(h.out(), typed).toContain(`language: ${language}`);
    }
    expect(parseArgs(['--language', 'ko'], { model: 'm', effort: 'high' }).language).toBe('ko');
    expect(parseArgs([], { model: 'm', effort: 'high' }).language).toBeNull();
    expect(USAGE).toContain('--language <code>');
  });

  it('M3.5 an unsupported language stops before anything else, with the same message the Action gives', async () => {
    const h = harness();
    expect(await runEvals([...CASES, '--language', 'fr', '--yes'], h.deps)).toMatchObject({
      exitCode: 2,
      executed: false,
    });
    expect(h.lines[0]).toBe('Unsupported language "fr". Use one of: en, ko, ja, zh-CN.');
    expect(h.createProvider).not.toHaveBeenCalled();
    expect(h.files).toEqual({});
    const missing = harness();
    expect(await runEvals(['--language'], missing.deps)).toMatchObject({ exitCode: 2 });
    expect(missing.lines[0]).toBe('--language needs a value.');
  });

  it('M3.5 the language reaches the model request, the rendered comment, the judge and the results file', async () => {
    const asked: string[] = [];
    const h = harness({
      createProvider: (request) => {
        const provider = fakeProvider(request.model);
        return {
          ...provider,
          generateReport: (req, signal) => {
            asked.push(req.context.language);
            return provider.generateReport(req, signal);
          },
        };
      },
    });
    const outcome = await runEvals([...CASES, '--language', 'kr', '--judge', '--yes'], h.deps);
    expect(asked).toEqual(['ko', 'ko']);

    const run = outcome.variants?.[0]?.runs[0];
    expect(run?.comment).toContain('**조치 필요 (');
    expect(run?.comment).toContain('P0 시나리오 없음'); // the stand-in report has no P0 ticket
    expect(run?.comment).not.toContain('Action needed');
    // The judge grades what the team would read: the Korean comment.
    expect(String(h.rubricBodies[0]?.messages[0]?.content)).toContain('**조치 필요 (');
    const saved = JSON.parse(Object.values(h.files)[0] as string) as SavedResults;
    expect(saved.language).toBe('ko');

    const english = harness();
    const en = await runEvals([...CASES, '--yes'], english.deps);
    expect(en.variants?.[0]?.runs[0]?.comment).toContain('**Action needed (');
    expect((JSON.parse(Object.values(english.files)[0] as string) as SavedResults).language).toBe('en');
  });
});

describe('--language with rounds: recorded, kept apart, never compared across languages (M3.5)', () => {
  /** Round 3 in English, kept; returns the harness that holds its files. */
  async function keptEnglishRound(): Promise<Harness> {
    const h = harness();
    await runEvals([...CASES, '--yes', '--judge', '--round', '3', '--change', 'checklist'], h.deps);
    await runEvals(['--round', '3', '--decision', 'keep'], h.deps);
    return h;
  }

  it('M3.5 a Korean run of a round gets its own files and record, beside the English one', async () => {
    const base = await keptEnglishRound();
    const englishSummary = base.files['evals/rounds/3/summary.md'];
    const englishResults = base.files['evals/rounds/3/raw/results.json'];
    const ko = harness(sharing(base));
    const outcome = await runEvals(
      [
        ...CASES,
        '--yes',
        '--judge',
        '--language',
        'ko',
        '--round',
        '3',
        '--change',
        'checklist, Korean output',
      ],
      ko.deps,
    );

    expect(outcome.resultsPath?.replace(/\\/g, '/')).toMatch(/\/rounds\/3\/raw\/results\.ko\.json$/);
    expect(Object.keys(base.files).sort()).toEqual([
      'evals/ROUNDS.md',
      'evals/rounds/3/raw/results.json',
      'evals/rounds/3/raw/results.ko.json',
      'evals/rounds/3/summary.ko.md',
      'evals/rounds/3/summary.md',
      'evals/rounds/index.json',
    ]);
    // The English run is untouched.
    expect(base.files['evals/rounds/3/summary.md']).toBe(englishSummary);
    expect(base.files['evals/rounds/3/raw/results.json']).toBe(englishResults);

    expect(records(base).map((r) => [r.round, r.language, r.decision, r.change])).toEqual([
      [3, 'en', 'keep', 'checklist'],
      [3, 'ko', 'pending', 'checklist, Korean output'],
    ]);
    const summary = base.files['evals/rounds/3/summary.ko.md'] as string;
    expect(summary).toContain('- Language: ko\n');
    expect(base.files['evals/rounds/3/summary.md']).toContain('- Language: en\n');
    const rows = (base.files['evals/ROUNDS.md'] as string).split('\n').filter((l) => /^\| \d/.test(l));
    expect(rows.map((r) => r.split(' | ')[5])).toEqual(['en', 'ko']);
    expect(ko.out()).toContain('Round 3 recorded in evals/rounds/3/summary.ko.md and evals/ROUNDS.md');

    // A second Korean run replaces the Korean record only.
    await runEvals(
      [...CASES, '--yes', '--judge', '--language', 'ko', '--round', '3', '--change', 'again'],
      harness(sharing(base)).deps,
    );
    expect(records(base).map((r) => [r.language, r.change])).toEqual([
      ['en', 'checklist'],
      ['ko', 'again'],
    ]);
  });

  it('M3.5 a round is compared only with a kept round in the same language', async () => {
    const base = await keptEnglishRound();
    const ko = harness(sharing(base));
    await runEvals(
      [...CASES, '--yes', '--judge', '--language', 'ko', '--round', '4', '--change', 'Korean output'],
      ko.deps,
    );
    expect(ko.lines.at(-1)).toBe(
      'No recommendation for round 4: The kept rounds were run in en and this one in ko. Reports in different languages are not compared.',
    );
    expect(base.files['evals/rounds/4/summary.ko.md']).toContain(
      'Reports in different languages are not compared.',
    );

    // An English round still finds its English baseline, with a Korean record in between.
    await runEvals(['--round', '4', '--decision', 'keep'], harness(sharing(base)).deps);
    const en = harness(sharing(base));
    await runEvals([...CASES, '--yes', '--judge', '--round', '5', '--change', 'next'], en.deps);
    expect(en.out()).toContain('Compared with round 3 (the last one kept):');

    // And a Korean round finds the Korean one.
    const nextKo = harness(sharing(base));
    await runEvals(
      [...CASES, '--yes', '--judge', '--language', 'ko', '--round', '5', '--change', 'next, Korean'],
      nextKo.deps,
    );
    expect(nextKo.out()).toContain('Compared with round 4 (the last one kept):');

    const all = records(base);
    const round5ko = all.find((r) => r.round === 5 && r.language === 'ko') as RoundRecord;
    expect(compareWithLastKept(round5ko, all).baseline).toBe(4);
    expect(compareWithLastKept({ ...round5ko, language: 'ja' }, all)).toMatchObject({
      baseline: null,
      recommendation: 'none',
    });
  });

  it('M3.5 records and files from before the language was stored count as English', () => {
    expect(languageOf({})).toBe('en');
    expect(languageOf({ language: 'ko' })).toBe('ko');
    expect([
      languageSuffix(undefined),
      languageSuffix('en'),
      languageSuffix('ko'),
      languageSuffix('zh-CN'),
    ]).toEqual(['', '', '.ko', '.zh-CN']);
  });

  it('M3.5 re-judging a Korean round keeps its language in the record and in the file names', async () => {
    const base = harness();
    await runEvals(
      [...CASES, '--yes', '--judge', '--language', 'ko', '--round', '6', '--change', 'Korean'],
      base.deps,
    );
    const plan = harness(sharing(base));
    await runEvals(['--rejudge', 'evals/rounds/6/raw/results.ko.json', '--round', '6'], plan.deps);
    expect(plan.out()).toMatch(/source: \S+results\.ko\.json \(prompt \S+, split selected, language ko\)/);

    // Scored again in place: the Korean record is updated, not turned into an English one.
    const fix = harness(sharing(base));
    await runEvals(
      [
        '--rejudge',
        'evals/rounds/6/raw/results.ko.json',
        '--cases',
        'report-timezone',
        '--round',
        '6',
        '--yes',
      ],
      fix.deps,
    );
    expect(records(base).map((r) => [r.round, r.language])).toEqual([[6, 'ko']]);
    expect(
      Object.keys(base.files)
        .filter((f) => f.endsWith('.md'))
        .sort(),
    ).toEqual(['evals/ROUNDS.md', 'evals/rounds/6/summary.ko.md']);
  });
});

describe('review pack language (M3.5)', () => {
  it('M3.5 the pack says which language its reports are in', async () => {
    const h = harness();
    await runEvals([...CASES, '--yes', '--judge', '--language', 'ko'], h.deps);
    const path = Object.keys(h.files)[0] as string;
    const o = harness(sharing(h));
    await runEvals(['--review-pack', path, '--sample', '2', '--out', 'pack.json'], o.deps);
    const pack = JSON.parse(h.files['pack.json'] as string) as ReviewPack;
    expect(pack.language).toBe('ko');
    expect(pack.samples).toHaveLength(2);
    expect(pack.samples[0]?.ticketMarkdown).toContain('**조치 필요 (');
    expect(o.out()).toContain('(language ko) written to pack.json');

    // A results file from before the language was recorded holds English reports.
    const saved = JSON.parse(h.files[path] as string) as SavedResults;
    delete saved.language;
    h.files['old.json'] = JSON.stringify(saved);
    await runEvals(['--review-pack', 'old.json', '--out', 'old-pack.json'], harness(sharing(h)).deps);
    expect((JSON.parse(h.files['old-pack.json'] as string) as ReviewPack).language).toBe('en');
  });
});
