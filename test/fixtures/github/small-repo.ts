import type {
  CommitNode,
  CommitsResult,
  IssuesResult,
  PullRequestNode,
  PullRequestReviewsResult,
  PullRequestsResult,
  RateLimit,
  RepositoryResult,
  ReviewNode,
} from '../../../src/github/github.types';
import {
  COMMITS_QUERY,
  ISSUES_QUERY,
  PULL_REQUEST_REVIEWS_QUERY,
  PULL_REQUESTS_QUERY,
  REPOSITORY_QUERY,
} from '../../../src/github/queries';
import type { FakeResponses } from '../../fakes/fake-github.client';

/**
 * A small repository: 3 PRs over 2 pages (a bot-authored PR; a PR with a
 * self-review and a `[bot]` review; a PR whose 31 reviews overflow the nested
 * page), 2 issues, 2 commits (one without a GitHub user).
 * Every item is updated inside WINDOW. Review pages are trimmed: the 31-review
 * PR carries 1 nested review plus 1 on the follow-up page.
 */
export const OWNER = 'acme';
export const NAME = 'widgets';
export const WINDOW = { from: '2026-09-07', to: '2026-10-26' };
export const PR_PAGE_1_CURSOR = 'pr-page-1';
export const REVIEW_OVERFLOW_CURSOR = 'review-cursor-30';
export const FINAL_RATE_LIMIT_REMAINING = 4985;

const rateLimit = (remaining: number): RateLimit => ({
  cost: 1,
  remaining,
  resetAt: '2026-10-29T00:00:00Z',
});

const user = (login: string) => ({ __typename: 'User', login });
const ALICE = user('alice');
const BOB = user('bob');
const CAROL = user('carol');
const DEPENDABOT = { __typename: 'Bot', login: 'dependabot' };
/** Detected as a bot by its login suffix only. */
const REVIEW_HELPER = user('review-helper[bot]');
const ACTIONS = { __typename: 'Bot', login: 'github-actions' };

const noReviews = {
  totalCount: 0,
  pageInfo: { hasNextPage: false, endCursor: null },
  nodes: [] as ReviewNode[],
};

function review(
  id: string,
  author: ReviewNode['author'],
  state: string,
  submittedAt: string,
  comments = 0,
): ReviewNode {
  return { id, state, submittedAt, author, comments: { totalCount: comments } };
}

const basePr = {
  isDraft: false,
  closedAt: null,
  mergedAt: null,
  mergedBy: null,
  baseRefName: 'main',
};

export const PR_BOT: PullRequestNode = {
  ...basePr,
  id: 'PR_1',
  number: 1,
  title: 'Bump lodash from 4.17.20 to 4.17.21',
  state: 'MERGED',
  createdAt: '2026-10-18T09:00:00Z',
  updatedAt: '2026-10-20T10:00:00Z',
  mergedAt: '2026-10-20T10:00:00Z',
  closedAt: '2026-10-20T10:00:00Z',
  additions: 3,
  deletions: 3,
  changedFiles: 1,
  author: DEPENDABOT,
  mergedBy: ALICE,
  reviews: noReviews,
};

export const PR_SELF_REVIEW: PullRequestNode = {
  ...basePr,
  id: 'PR_2',
  number: 2,
  title: 'Add widget API',
  state: 'MERGED',
  createdAt: '2026-10-10T08:00:00Z',
  updatedAt: '2026-10-15T12:00:00Z',
  mergedAt: '2026-10-15T12:00:00Z',
  closedAt: '2026-10-15T12:00:00Z',
  additions: 120,
  deletions: 4,
  changedFiles: 6,
  author: ALICE,
  mergedBy: ALICE,
  reviews: {
    totalCount: 2,
    pageInfo: { hasNextPage: false, endCursor: 'r2' },
    nodes: [
      review('R_1', ALICE, 'COMMENTED', '2026-10-11T08:00:00Z', 2),
      review('R_2', REVIEW_HELPER, 'COMMENTED', '2026-10-10T08:05:00Z', 5),
    ],
  },
};

export const PR_OVERFLOW: PullRequestNode = {
  ...basePr,
  id: 'PR_3',
  number: 3,
  title: 'Refactor storage layer',
  state: 'OPEN',
  createdAt: '2026-09-10T08:00:00Z',
  updatedAt: '2026-09-20T08:00:00Z',
  additions: 800,
  deletions: 650,
  changedFiles: 40,
  author: BOB,
  reviews: {
    totalCount: 31,
    pageInfo: { hasNextPage: true, endCursor: REVIEW_OVERFLOW_CURSOR },
    nodes: [review('R_3', ALICE, 'APPROVED', '2026-09-12T08:00:00Z', 1)],
  },
};

export const PR_PAGE_1: PullRequestsResult = {
  repository: {
    pullRequests: {
      pageInfo: { hasNextPage: true, endCursor: PR_PAGE_1_CURSOR },
      nodes: [PR_BOT, PR_SELF_REVIEW],
    },
  },
  rateLimit: rateLimit(4989),
};

export const PR_PAGE_2: PullRequestsResult = {
  repository: {
    pullRequests: {
      pageInfo: { hasNextPage: false, endCursor: 'pr-page-2' },
      nodes: [PR_OVERFLOW],
    },
  },
  rateLimit: rateLimit(4988),
};

export const OVERFLOW_REVIEWS: ReviewNode[] = [
  review('R_4', CAROL, 'CHANGES_REQUESTED', '2026-09-14T08:00:00Z', 3),
];

export const REVIEW_OVERFLOW_PAGE: PullRequestReviewsResult = {
  node: {
    reviews: {
      pageInfo: { hasNextPage: false, endCursor: 'review-cursor-31' },
      nodes: OVERFLOW_REVIEWS,
    },
  },
  rateLimit: rateLimit(4987),
};

export const ISSUE_PAGE: IssuesResult = {
  repository: {
    issues: {
      pageInfo: { hasNextPage: false, endCursor: 'issue-page-1' },
      nodes: [
        {
          id: 'I_1',
          number: 10,
          title: 'Widgets render twice',
          state: 'OPEN',
          createdAt: '2026-10-08T08:00:00Z',
          updatedAt: '2026-10-09T08:00:00Z',
          closedAt: null,
          author: CAROL,
          labels: { nodes: [{ name: 'bug' }, { name: 'ui' }] },
        },
        {
          id: 'I_2',
          number: 11,
          title: 'Nightly build failed',
          state: 'CLOSED',
          createdAt: '2026-09-15T02:00:00Z',
          updatedAt: '2026-09-16T02:00:00Z',
          closedAt: '2026-09-16T02:00:00Z',
          author: ACTIONS,
          labels: { nodes: [] },
        },
      ],
    },
  },
  rateLimit: rateLimit(4986),
};

export const COMMITS: CommitNode[] = [
  {
    oid: 'a'.repeat(40),
    committedDate: '2026-10-14T16:00:00Z',
    additions: 100,
    deletions: 2,
    author: {
      name: 'Alice A.',
      email: 'alice@example.com',
      user: { login: 'alice' },
    },
  },
  {
    oid: 'b'.repeat(40),
    committedDate: '2026-09-30T11:00:00Z',
    additions: 7,
    deletions: 1,
    author: { name: 'Jane Offline', email: 'jane@example.com', user: null },
  },
];

export function repositoryResult(
  overrides: Partial<{
    hasIssuesEnabled: boolean;
    pullRequestCount: number;
  }> = {},
): RepositoryResult {
  return {
    repository: {
      id: 'R_kgDOwidgets',
      databaseId: 4242,
      nameWithOwner: `${OWNER}/${NAME}`,
      defaultBranchRef: { name: 'main' },
      hasIssuesEnabled: overrides.hasIssuesEnabled ?? true,
      pullRequests: { totalCount: overrides.pullRequestCount ?? 3 },
    },
    rateLimit: rateLimit(4990),
  };
}

/** Commits whose committedDate lies in `[since, until]`, like GitHub's history filter. */
export function commitsResult(vars: Record<string, unknown>): CommitsResult {
  const since = Date.parse(String(vars.since));
  const until = Date.parse(String(vars.until));
  const nodes = COMMITS.filter((c) => {
    const t = Date.parse(c.committedDate);
    return t >= since && t <= until;
  });
  return {
    repository: {
      defaultBranchRef: {
        target: {
          history: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes,
          },
        },
      },
    },
    rateLimit: rateLimit(FINAL_RATE_LIMIT_REMAINING),
  };
}

/** Responses for every query the sync issues against the small repo. */
export function smallRepoResponses(
  repo: Parameters<typeof repositoryResult>[0] = {},
): FakeResponses {
  return {
    [REPOSITORY_QUERY]: () => repositoryResult(repo),
    [PULL_REQUESTS_QUERY]: (vars) =>
      vars.cursor === PR_PAGE_1_CURSOR ? PR_PAGE_2 : PR_PAGE_1,
    [PULL_REQUEST_REVIEWS_QUERY]: () => REVIEW_OVERFLOW_PAGE,
    [ISSUES_QUERY]: () => ISSUE_PAGE,
    [COMMITS_QUERY]: commitsResult,
  };
}
