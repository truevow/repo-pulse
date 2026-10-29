import { HttpException } from '@nestjs/common';

export type ProblemType =
  | 'validation-error'
  | 'not-found'
  | 'repo-not-synced'
  | 'github-token-missing'
  | 'github-repo-not-found'
  | 'github-unavailable'
  | 'llm-not-configured'
  | 'llm-unavailable'
  | 'synthesis-failed'
  | 'no-signal-data'
  | 'rate-limited'
  | 'conflict'
  | 'internal';

export interface ProblemInit {
  status: number;
  type: ProblemType;
  title: string;
  detail?: string;
  extensions?: Record<string, unknown>;
  headers?: Record<string, string>;
}

/** An error that maps 1:1 onto an RFC 9457 problem details response. */
export class ProblemException extends HttpException {
  readonly problem: ProblemInit;

  constructor(problem: ProblemInit) {
    super(problem.detail ?? problem.title, problem.status);
    this.problem = problem;
  }
}
