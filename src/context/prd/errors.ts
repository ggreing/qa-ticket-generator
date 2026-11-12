/** Typed PRD fetch failures. Owner: qa-work-session-a. */

/**
 * - `permission`: fixable by the user's credentials/permissions → `prd_permission` (PRD-10):
 *   GitHub 403/404, Jira 401/403, Notion 404 (page not shared with the integration)
 * - `auth`: credentials rejected where PRD-10 does not apply (Notion 401)
 * - `not_found`: document does not exist (Jira 404, GitHub 410)
 * - `invalid_ref`: the reference cannot be fetched by this provider
 * - `http`: any other failed response
 */
export type PrdFetchErrorKind = 'auth' | 'permission' | 'not_found' | 'invalid_ref' | 'http';

/**
 * A PRD fetch failure whose `message` is safe to show in a PR comment: it never contains
 * document text, response bodies or credentials. The registry turns it into a warning.
 */
export class PrdFetchError extends Error {
  readonly kind: PrdFetchErrorKind;
  readonly status: number | undefined;

  constructor(kind: PrdFetchErrorKind, message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'PrdFetchError';
    this.kind = kind;
    this.status = options.status;
  }
}

/** HTTP failure carrying status and headers so {@link withRetry} can classify it. */
export class HttpStatusError extends Error {
  readonly status: number;
  readonly headers: Record<string, string>;

  constructor(status: number, headers: Record<string, string>) {
    super(`HTTP ${status}`);
    this.name = 'HttpStatusError';
    this.status = status;
    this.headers = headers;
  }
}
