/**
 * SPEC v3 — Slack notices for plan and verify runs. Implemented in src/delivery/slack-v3.ts.
 * OWNERSHIP: control session.
 */
import type { CaseSetSummary } from './cases';
import type { DeliveryState, Warning } from './contracts';
import type { VerifySummaryData } from './verify-pipeline';

export interface SlackNoticeResult {
  ok: boolean;
  /** Merged into the PR comment's DeliveryState (verify, bot mode: the message to update next time). */
  statePatch?: Pick<DeliveryState, 'slack'>;
  warning?: Warning;
}

export interface PlanNoticeContext {
  /** Spec-side case list a sink published. */
  listUrl?: string;
  /** What the primary sink changed in this run. */
  changes?: { created: number; updated: number; obsoleted: number };
}

/** Never throws: a failed notice is a warning. */
export interface SlackNotifier {
  postVerify(data: VerifySummaryData, state: DeliveryState): Promise<SlackNoticeResult>;
  postPlan(summary: CaseSetSummary, ctx?: PlanNoticeContext): Promise<SlackNoticeResult>;
}
