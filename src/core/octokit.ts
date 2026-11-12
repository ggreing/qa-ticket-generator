import type { getOctokit } from '@actions/github';

/** The Octokit client type returned by @actions/github (REST + paginate). */
export type Octokit = ReturnType<typeof getOctokit>;
