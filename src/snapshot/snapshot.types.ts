import type {
  Commit,
  Issue,
  PullRequest,
  Repository,
  Review,
} from '@prisma/client';

type Iso<T, K extends keyof T> = {
  [P in keyof T]: P extends K
    ? null extends T[P]
      ? string | null
      : string
    : T[P];
};

type SnapshotReview = Iso<
  Omit<Review, 'id' | 'pullRequestId' | 'authorId'>,
  'submittedAt'
> & { author: string | null };

type SnapshotPullRequest = Iso<
  Omit<PullRequest, 'id' | 'repositoryId' | 'authorId' | 'mergedById'>,
  'createdAt' | 'updatedAt' | 'mergedAt' | 'closedAt'
> & {
  author: string | null;
  mergedBy: string | null;
  reviews: SnapshotReview[];
};

type SnapshotIssue = Iso<
  Omit<Issue, 'id' | 'repositoryId' | 'authorId'>,
  'createdAt' | 'updatedAt' | 'closedAt'
> & { author: string | null };

type SnapshotCommit = Iso<
  Omit<Commit, 'id' | 'repositoryId' | 'authorId'>,
  'committedDate'
> & { author: string | null };

/** A portable, diffable dump of one repository. All dates are ISO strings. */
export interface Snapshot {
  version: 1;
  exportedAt: string;
  repository: Pick<
    Repository,
    | 'githubId'
    | 'owner'
    | 'name'
    | 'defaultBranch'
    | 'hasIssuesEnabled'
    | 'hasPullRequests'
  > & { coveredFrom: string; coveredTo: string; lastSyncedAt: string };
  actors: Array<{ login: string; isBot: boolean }>;
  pullRequests: SnapshotPullRequest[];
  issues: SnapshotIssue[];
  commits: SnapshotCommit[];
}
