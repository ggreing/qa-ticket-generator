/** UI-string table shape for rendered reports (ADR-0010). Owner: qa-work-session-c(fable). */
import type { AlignmentStatus, FileSkipReason, QaReport } from '../../../core/contracts';

type Finding = QaReport['prdAlignment']['findings'][number];
type Scenario = QaReport['scenarios'][number];

export interface Strings {
  title: string;
  alignment: string;
  alignmentStatus: Record<AlignmentStatus, string>;
  /** DLV-09 badge. */
  noPrd: string;
  linked: string;
  sections: {
    alignment: string;
    scenarios: string;
    risks: string;
    assumptions: string;
    notes: string;
    skippedFiles: string;
    redactions: string;
  };
  table: { requirement: string; status: string; evidence: string };
  requirementStatus: Record<Finding['status'], string>;
  scenarioType: Record<Scenario['type'], string>;
  level: Record<Scenario['confidence'], string>;
  related: string;
  why: string;
  confidence: string;
  /** DLV-03 notice. */
  omittedScenarios: (count: number) => string;
  omittedFindings: (count: number) => string;
  truncated: string;
  runFailed: string;
  errorCode: string;
  /** What the user should do about an error, by error code (SPEC §10). Codes without a hint show only the message. */
  errorHint: Partial<Record<string, string>>;
  noFiles: string;
  skipped: string;
  dryRun: string;
  footer: {
    tokens: (input: string, output: string) => string;
    cache: (read: string, write: string) => string;
    calls: (count: number) => string;
    filesSkipped: (count: number) => string;
    redactions: (count: number) => string;
  };
  skipReason: Record<FileSkipReason, string>;
  slack: {
    openPr: string;
    viewReport: string;
    scenarios: string;
    topRisks: string;
    findings: string;
    detailsInThread: string;
  };
}
