/**
 * Zod schemas shared across modules (SPEC §7, §4.3).
 *
 * QaReportSchema is sent to the model as a Structured Outputs schema, so keep it to
 * plain objects/arrays/enums/strings: no min/max/regex refinements (enforce those in code,
 * see `normalizeReport` in src/llm). OWNERSHIP: control session only.
 */
import { z } from 'zod';

export const RequirementStatus = z.enum(['covered', 'missing', 'contradicts', 'unclear']);
export const AlignmentStatusSchema = z.enum(['aligned', 'partial', 'misaligned', 'no_prd']);
export const ScenarioType = z.enum(['happy_path', 'edge_case', 'negative', 'regression']);
export const Priority = z.enum(['P0', 'P1', 'P2']);
export const Level = z.enum(['high', 'medium', 'low']);

export const QaReportSchema = z.object({
  summary: z.string().describe('What the PR changes, in at most 3 sentences.'),
  prdAlignment: z.object({
    status: AlignmentStatusSchema.describe(
      'aligned = every requirement covered; partial = any missing/unclear; misaligned = any contradicts; no_prd = no linked PRD.',
    ),
    findings: z.array(
      z.object({
        requirement: z.string().describe('Acceptance criterion text or a faithful summary of it.'),
        source: z.string().describe('PRD reference the requirement came from, e.g. "PROJ-123" or "#45".'),
        status: RequirementStatus,
        evidence: z
          .string()
          .describe('Code evidence: file and function names that implement or contradict it.'),
        files: z.array(z.string()),
      }),
    ),
  }),
  scenarios: z.array(
    z.object({
      id: z.string().describe('Sequential id such as "S-01".'),
      title: z.string(),
      type: ScenarioType,
      priority: Priority.describe('P0 = data loss, payments, security or the core flow.'),
      given: z.array(z.string()),
      when: z.array(z.string()),
      then: z.array(z.string()),
      testData: z
        .array(z.string())
        .describe(
          'Concrete test data as "name = value" lines (accounts, amounts, timestamps, payloads); empty only when none is needed.',
        ),
      relatedRequirements: z.array(z.string()),
      relatedFiles: z.array(z.string()),
      rationale: z.string().describe('Why this scenario matters for this change.'),
      confidence: Level,
    }),
  ),
  risks: z.array(
    z.object({
      title: z.string(),
      severity: Level,
      description: z.string(),
      files: z.array(z.string()),
    }),
  ),
  assumptions: z.array(z.string()).describe('Anything assumed rather than read from the PRD or code.'),
});

export type QaReport = z.infer<typeof QaReportSchema>;

// ───────────────────────────── v3: spec-driven QA cases (SPEC.v3 §3) ─────────────────────────────

export const TechniqueSchema = z.enum([
  'happy_path',
  'boundary',
  'equivalence',
  'invalid_input',
  'state_transition',
  'permission',
  'concurrency',
  'failure',
  'idempotency',
  'compatibility',
  'locale_time',
  'data_integrity',
]);

const CaseDraftFields = {
  title: z.string().describe('Short noun phrase: target + condition + result, like a line in a QA sheet.'),
  acLabels: z
    .array(z.string())
    .describe('Requirement labels this case tests, e.g. "AC2". Empty for code-derived risks.'),
  technique: TechniqueSchema,
  priority: Priority,
  preconditions: z.array(z.string()),
  testData: z.array(z.string()).describe('Concrete values as "name = value" lines.'),
  steps: z.array(z.string()).describe('Short imperative actions, one per line.'),
  expected: z.array(z.string()).describe('Observable results; the first line decides pass or fail.'),
  whyEasyToMiss: z
    .string()
    .describe('One factual sentence: what the spec leaves out that makes this easy to miss.'),
};

/** Plan phase output (one call per AC group, then merged). */
export const PlanOutputSchema = z.object({
  cases: z.array(
    z.object({
      ...CaseDraftFields,
      reuseCaseId: z
        .string()
        .nullable()
        .describe('Existing caseId when this case keeps the same test intent as an existing one, else null.'),
    }),
  ),
});
export type PlanOutput = z.infer<typeof PlanOutputSchema>;

/** Verify phase output (per PR). */
export const VerifyOutputSchema = z.object({
  statuses: z.array(
    z.object({
      caseId: z.string(),
      status: z.enum(['implemented', 'missing', 'contradicts', 'unknown']),
      evidence: z.string().describe('One factual sentence naming the file and function.'),
      files: z.array(z.string()),
    }),
  ),
  newCases: z
    .array(
      z.object({
        // First, so it is decided before the case is written.
        sameAsCaseId: z
          .string()
          .nullable()
          .describe(
            'Id of an existing case that already covers the same risk (same place in the code, same reason), else null. A case with an id here is discarded.',
          ),
        ...CaseDraftFields,
      }),
    )
    .describe('Risks visible only in the code, not covered by any case.'),
  prdAlignment: QaReportSchema.shape.prdAlignment,
});
export type VerifyOutput = z.infer<typeof VerifyOutputSchema>;

// ───────────────────────────── repo config file (.github/qa-ticket-generator.yml) ─────────────────────────────

export const RepoConfigSchema = z
  .object({
    filters: z
      .object({
        exclude: z.array(z.string()).default([]),
        include: z.array(z.string()).default([]),
      })
      .partial()
      .default({}),
    prd: z
      .object({
        jiraProjectKeys: z.array(z.string()),
        jiraAcceptanceCriteriaField: z.string(),
        maxDocuments: z.number().int().min(1).max(10),
      })
      .partial()
      .default({}),
    scoring: z
      .object({
        boostPaths: z.array(z.string()),
        penalizePaths: z.array(z.string()),
      })
      .partial()
      .default({}),
    prompt: z
      .object({
        extraInstructions: z.string().max(4000),
        glossary: z.array(z.object({ term: z.string(), meaning: z.string() })).max(100),
        /** SPEC v3 §3.1 — a few lines from the team's own QA sheet; the model copies the voice. */
        styleExamples: z.array(z.string().max(500)).max(20),
      })
      .partial()
      .default({}),
  })
  .strict();

export type RepoConfig = z.infer<typeof RepoConfigSchema>;
