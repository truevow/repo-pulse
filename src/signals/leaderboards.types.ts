import type { BucketSize, Window } from './buckets';
import type { MetricName } from './metric-names';

export interface MetricsQuery {
  repositoryId: number;
  /** Used only to build example URLs (`https://github.com/<owner>/<repo>/...`). */
  owner: string;
  repo: string;
  window: Window;
  size: BucketSize;
  includeBots: boolean;
}

export type BucketMetricsRow = { bucket: string } & Record<
  MetricName,
  number | null
> & { top_reviewer: string | null };

export interface Leaderboards {
  contributors: Array<{
    login: string;
    mergedPrs: number;
    commits: number;
    linesChanged: number;
  }>;
  reviewers: Array<{ login: string; reviews: number; approvals: number }>;
  mergers: Array<{ login: string; prsMerged: number }>;
}

export interface BucketExamplesQuery extends MetricsQuery {
  metric: MetricName;
  bucketStart: Date;
  limit: number;
  /** Reviewer login; narrows `review_concentration_*` examples to their PRs. */
  entity?: string;
}

export interface ContributorActivityRow {
  bucket: string;
  prs_opened: number;
  prs_merged: number;
  reviews_given: number;
  commits: number;
}
