export type ActorNode = { __typename: string; login: string } | null;

export interface RateLimit {
  cost: number;
  remaining: number;
  resetAt: string;
}

export interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface ReviewNode {
  id: string;
  state: string;
  submittedAt: string | null;
  author: ActorNode;
  comments: { totalCount: number };
}

export interface PullRequestNode {
  id: string;
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  baseRefName: string;
  author: ActorNode;
  mergedBy: ActorNode;
  reviews: {
    totalCount: number;
    pageInfo: PageInfo;
    nodes: ReviewNode[];
  };
}

export interface IssueNode {
  id: string;
  number: number;
  title: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  author: ActorNode;
  labels: { nodes: { name: string }[] };
}

export interface CommitNode {
  oid: string;
  committedDate: string;
  additions: number;
  deletions: number;
  author: {
    name: string | null;
    email: string | null;
    user: { login: string } | null;
  } | null;
}

export interface RepositoryResult {
  repository: {
    id: string;
    databaseId: number;
    nameWithOwner: string;
    defaultBranchRef: { name: string } | null;
    hasIssuesEnabled: boolean;
    pullRequests: { totalCount: number };
  } | null;
  rateLimit: RateLimit;
}

export interface PullRequestsResult {
  repository: {
    pullRequests: { pageInfo: PageInfo; nodes: PullRequestNode[] };
  } | null;
  rateLimit: RateLimit;
}

export interface PullRequestReviewsResult {
  node: { reviews: { pageInfo: PageInfo; nodes: ReviewNode[] } } | null;
  rateLimit: RateLimit;
}

export interface IssuesResult {
  repository: {
    issues: { pageInfo: PageInfo; nodes: IssueNode[] };
  } | null;
  rateLimit: RateLimit;
}

export interface CommitsResult {
  repository: {
    defaultBranchRef: {
      target: { history?: { pageInfo: PageInfo; nodes: CommitNode[] } };
    } | null;
  } | null;
  rateLimit: RateLimit;
}
