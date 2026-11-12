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
      })
      .partial()
      .default({}),
  })
  .strict();

export type RepoConfig = z.infer<typeof RepoConfigSchema>;
