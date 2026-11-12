/**
 * Eval dataset format (SPEC §12.3). One directory per case under `evals/cases/<id>/`:
 * `pr.json`, `files.json`, `prd/*.json`, `expected.json`. All data is synthetic.
 * Owner: qa-work-session-c(fable).
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { ChangedFile, PrdDocument, PullRequestInfo } from '../src/core/contracts';
import { AlignmentStatusSchema, RequirementStatus } from '../src/core/schema';

const FileStatusSchema = z.enum([
  'added',
  'modified',
  'removed',
  'renamed',
  'copied',
  'changed',
  'unchanged',
]);

export const PullRequestSchema = z
  .object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    number: z.number().int().positive(),
    title: z.string().min(1),
    body: z.string(),
    author: z.string().min(1),
    htmlUrl: z.url(),
    baseRef: z.string().min(1),
    baseSha: z.string().regex(/^[0-9a-f]{40}$/),
    headRef: z.string().min(1),
    headSha: z.string().regex(/^[0-9a-f]{40}$/),
    headRepoFullName: z.string().min(1),
    isFork: z.boolean(),
    draft: z.boolean(),
    labels: z.array(z.string()),
  })
  .strict();

export const ChangedFileSchema = z
  .object({
    path: z.string().min(1),
    previousPath: z.string().optional(),
    status: FileStatusSchema,
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    patch: z.string().optional(),
    patchMissing: z.boolean(),
    headContent: z.string().optional(),
  })
  .strict();

export const PrdDocumentSchema = z
  .object({
    ref: z
      .object({
        source: z.enum(['github', 'jira', 'notion']),
        id: z.string().min(1),
        url: z.url().optional(),
        raw: z.string().min(1),
      })
      .strict(),
    title: z.string().min(1),
    bodyMarkdown: z.string().min(1),
    acceptanceCriteria: z.array(z.string()),
    url: z.url(),
    meta: z.record(z.string(), z.string()),
  })
  .strict();

/** AND of ORs: every group needs at least one of its terms (case-insensitive substring). */
const TermGroups = z.array(z.array(z.string().min(2)).min(1)).min(1);
const ReportField = z.enum(['summary', 'findings', 'scenarios', 'risks', 'assumptions']);

export const ExpectedSchema = z
  .object({
    expectedAlignment: AlignmentStatusSchema,
    /** Requirements the report must judge, each with the statuses that count as correct. */
    mustFindings: z.array(
      z
        .object({
          id: z.string().min(1),
          requirement: z.string().min(1),
          /** Requirement labels as they appear in the PRD, e.g. "AC3"; matched as whole tokens. */
          labels: z.array(z.string().min(2)).min(1),
          /** Fallback when the model drops the label: substrings of the requirement text. */
          keywords: z.array(z.string().min(3)),
          accept: z.array(RequirementStatus).min(1),
        })
        .strict(),
    ),
    /** Risks at least one scenario must cover. `risk` is the meaning (for humans and the judge). */
    mustScenarios: z
      .array(z.object({ id: z.string().min(1), risk: z.string().min(1), keywords: TermGroups }).strict())
      .min(1),
    /** Things the report must not contain, e.g. features that exist in neither PRD nor code. */
    forbidden: z.array(
      z
        .object({
          id: z.string().min(1),
          description: z.string().min(1),
          patterns: z.array(z.string().min(3)).min(1),
          fields: z.array(ReportField).min(1),
        })
        .strict(),
    ),
    /** Present on prompt-injection cases: the attempt must be reported in `risks`. */
    injection: z.object({ riskKeywords: TermGroups }).strict().optional(),
    tags: z.array(z.string().min(1)).min(1),
    /** One line on what was planted, for people reading results. Never shown to the model. */
    notes: z.string().min(1),
  })
  .strict();

export type Expected = z.infer<typeof ExpectedSchema>;

/** Per-case overrides of the Action defaults, e.g. a small token budget that forces map-reduce. */
export const CaseOptionsSchema = z.object({ tokenBudget: z.number().int().min(8_000).max(900_000) }).strict();
export type CaseOptions = z.infer<typeof CaseOptionsSchema>;

export const SplitsSchema = z.object({ dev: z.array(z.string()), test: z.array(z.string()) }).strict();
export type Split = 'dev' | 'test';

/** `evals/real-sources.json`: where each real-PR snapshot under `evals/real/` came from. */
export const RealSourcesSchema = z.array(
  z.object({ id: z.string().regex(/^[a-z0-9-]+$/), split: z.enum(['dev', 'test']) }).loose(),
);

export interface EvalCase {
  id: string;
  pr: PullRequestInfo;
  files: ChangedFile[];
  prdDocuments: PrdDocument[];
  /** Ground truth. Null for real PRs, which are graded by the rubric judge and people only. */
  expected: Expected | null;
  options?: CaseOptions;
  origin?: 'synthetic' | 'real';
  split?: Split;
}

/** A case with ground truth, for code that only makes sense with one. */
export type GradedCase = EvalCase & { expected: Expected };

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const readJsonIfPresent = (path: string): unknown => (existsSync(path) ? readJson(path) : undefined);

/**
 * Fingerprint of everything the model is shown for a case (PR, files, PRD), not of the expected
 * answers. A saved run whose hash differs from the current case was produced for other inputs.
 */
export function inputHashOf(evalCase: EvalCase): string {
  const visible = JSON.stringify([evalCase.pr, evalCase.files, evalCase.prdDocuments]);
  return createHash('sha256').update(visible).digest('hex').slice(0, 16);
}

/** Loads and validates one case directory. Throws a ZodError naming the bad field. */
export function loadCase(casesRoot: string, id: string): EvalCase {
  const dir = join(casesRoot, id);
  const prdDir = join(dir, 'prd');
  let prdFiles: string[] = [];
  try {
    prdFiles = readdirSync(prdDir)
      .filter((f) => f.endsWith('.json'))
      .sort();
  } catch {
    // a case without a prd/ directory has no linked PRD
  }
  return {
    id,
    pr: PullRequestSchema.parse(readJson(join(dir, 'pr.json'))),
    files: z
      .array(ChangedFileSchema)
      .min(1)
      .parse(readJson(join(dir, 'files.json'))),
    prdDocuments: prdFiles.map((f) => PrdDocumentSchema.parse(readJson(join(prdDir, f)))),
    expected: existsSync(join(dir, 'expected.json'))
      ? ExpectedSchema.parse(readJson(join(dir, 'expected.json')))
      : null,
    ...(existsSync(join(dir, 'options.json'))
      ? { options: CaseOptionsSchema.parse(readJson(join(dir, 'options.json'))) }
      : {}),
  };
}

export interface Dataset {
  /** Every case found on disk, synthetic first, each tagged with its origin and split. */
  cases: EvalCase[];
  /** Real cases listed in real-sources.json whose snapshot is not on this machine. */
  missingReal: string[];
}

/**
 * Loads the whole eval set from the `evals/` directory: synthetic cases from `cases/` with their
 * split from the generated `splits.json`, and real-PR snapshots from `real/` (not committed) with
 * their split from `real-sources.json`. A synthetic case missing from `splits.json` is an error;
 * a real case missing on disk is reported, not fatal.
 */
export function loadDataset(evalsRoot: string): Dataset {
  const splits = SplitsSchema.parse(
    readJsonIfPresent(join(evalsRoot, 'splits.json')) ?? { dev: [], test: [] },
  );
  const splitOf = (id: string): Split | undefined =>
    splits.dev.includes(id) ? 'dev' : splits.test.includes(id) ? 'test' : undefined;

  const synthetic = loadCases(join(evalsRoot, 'cases')).map((c): EvalCase => {
    const split = splitOf(c.id);
    if (!split) throw new Error(`Eval case ${c.id} is in neither split. Run "npm run eval:build-cases".`);
    return { ...c, origin: 'synthetic', split };
  });

  const sources = RealSourcesSchema.parse(readJsonIfPresent(join(evalsRoot, 'real-sources.json')) ?? []);
  const realRoot = join(evalsRoot, 'real');
  const real: EvalCase[] = [];
  const missingReal: string[] = [];
  for (const source of sources) {
    if (!existsSync(join(realRoot, source.id, 'pr.json'))) missingReal.push(source.id);
    else real.push({ ...loadCase(realRoot, source.id), origin: 'real', split: source.split });
  }
  return { cases: [...synthetic, ...real], missingReal };
}

/** Loads every case under `casesRoot`, or only `ids` when given, in id order. */
export function loadCases(casesRoot: string, ids?: string[]): EvalCase[] {
  const all = readdirSync(casesRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const wanted = ids && ids.length > 0 ? ids : all;
  const unknown = wanted.filter((id) => !all.includes(id));
  if (unknown.length > 0) throw new Error(`Unknown eval case(s): ${unknown.join(', ')}`);
  return wanted.map((id) => loadCase(casesRoot, id));
}
