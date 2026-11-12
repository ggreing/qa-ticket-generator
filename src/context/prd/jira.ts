/** Jira Cloud PRD provider: REST v3 + ADF to Markdown (PRD-04/07). Owner: qa-work-session-a. */
import type { PrdProvider } from '../../core/contracts';
import { notImplemented } from '../../core/stub';

export interface JiraOptions {
  baseUrl: string;
  email: string;
  apiToken: string;
  acceptanceCriteriaField?: string;
}

export function createJiraProvider(_options: JiraOptions | null): PrdProvider {
  return notImplemented('prd/createJiraProvider');
}
