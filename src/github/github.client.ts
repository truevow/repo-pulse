import { GitHubError } from './github.errors';
import type { RateLimit } from './github.types';

export interface GitHubClient {
  query<T>(document: string, variables: Record<string, unknown>): Promise<T>;
  /** The rate limit seen on the most recent response, when the client tracks it. */
  readonly lastRateLimit?: RateLimit | null;
}

export const GITHUB_CLIENT = Symbol('GITHUB_CLIENT');

/** Stand-in used when no GITHUB_TOKEN is configured; the app still boots. */
export class MissingTokenGitHubClient implements GitHubClient {
  query<T>(): Promise<T> {
    return Promise.reject(
      new GitHubError('token_missing', 'GITHUB_TOKEN is not configured'),
    );
  }
}
