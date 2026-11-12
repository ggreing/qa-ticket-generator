/** UI-string table shape for rendered reports (ADR-0010). Owner: qa-work-session-c(fable). */
import type { AlignmentStatus, FileSkipReason, QaReport } from '../../../core/contracts';

type Finding = QaReport['prdAlignment']['findings'][number];
type Scenario = QaReport['scenarios'][number];

export interface Strings {
  title: string;
  alignmentStatus: Record<AlignmentStatus, string>;
  /** DLV-09 badge. */
  noPrd: string;
  linked: string;
  /** Top section (SPEC §4.6, M3.5): what the author must fix, then the P0 checklist. */
  actionNeeded: (count: number) => string;
  allCovered: (count: number) => string;
  needsCheck: (count: number) => string;
  p0Checklist: (count: number) => string;
  noP0: string;
  /** "and N more", for lists capped to keep the top section on one screen. */
  more: (count: number) => string;
  /** Ticket card field labels. */
  card: { given: string; data: string; steps: string; expected: string; related: string; why: string };
  confidence: string;
  level: Record<Scenario['confidence'], string>;
  otherTickets: (count: number) => string;
  requirementDetails: (count: number) => string;
  sections: {
    risks: string;
    assumptions: string;
    notes: string;
    skippedFiles: string;
    redactions: string;
  };
  table: { requirement: string; status: string; evidence: string };
  requirementStatus: Record<Finding['status'], string>;
  /** DLV-03 notices. */
  omittedTickets: (count: number) => string;
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
    tickets: string;
    detailsInThread: string;
  };
}
