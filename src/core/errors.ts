/** Error codes surfaced to users (SPEC §10). OWNERSHIP: control session only. */
export type QtgErrorCode =
  | 'config_invalid'
  | 'llm_auth'
  | 'llm_unavailable'
  | 'llm_refusal'
  | 'llm_schema'
  | 'llm_truncated'
  | 'prd_required'
  | 'github_api'
  | 'cancelled'
  | 'internal';

/** An expected failure with a message safe to show in a PR comment (never include secrets or PRD text). */
export class QtgError extends Error {
  readonly code: QtgErrorCode;
  readonly userMessage: string;

  constructor(code: QtgErrorCode, userMessage: string, options?: { cause?: unknown }) {
    super(`${code}: ${userMessage}`, options);
    this.name = 'QtgError';
    this.code = code;
    this.userMessage = userMessage;
  }
}

export function toQtgError(err: unknown): QtgError {
  if (err instanceof QtgError) return err;
  if (err instanceof Error && err.name === 'AbortError') {
    return new QtgError('cancelled', 'The run was cancelled.', { cause: err });
  }
  return new QtgError('internal', 'Unexpected internal error. See the workflow log for details.', {
    cause: err,
  });
}
