import { GitHubError } from './github.errors';

export interface GitHubClient {
  query<T>(document: string, variables: Record<string, unknown>): Promise<T>;
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
