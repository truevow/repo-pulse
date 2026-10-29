export type GitHubErrorKind =
  | 'token_missing'
  | 'not_found'
  | 'unauthorized'
  | 'forbidden'
  | 'unavailable'
  | 'bad_query';

export class GitHubError extends Error {
  constructor(
    public kind: GitHubErrorKind,
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

/**
 * Log fields for an error. A GitHubError's message may carry GitHub's raw
 * text, so only its kind and status are logged; other errors are logged whole.
 */
export function errorLogFields(err: unknown): Record<string, unknown> {
  if (err instanceof GitHubError) return { kind: err.kind, status: err.status };
  return { err };
}
