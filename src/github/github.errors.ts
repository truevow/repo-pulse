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
