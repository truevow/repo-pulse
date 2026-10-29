import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { bucketKey, buildBuckets, type BucketSpec } from './buckets';
import type {
  BucketExamplesQuery,
  BucketMetricsRow,
  ContributorActivityRow,
  Leaderboards,
  MetricsQuery,
} from './leaderboards.types';
import { METRIC_NAMES, type FactUnit, type MetricName } from './metric-names';
import {
  commitAuthorsSql,
  contributorActivitySql,
  contributorsSql,
  issueMetricsSql,
  largestCommitsSql,
  longestClosedIssuesSql,
  mergersSql,
  mostReviewedSql,
  newestIssuesSql,
  prsBySizeSql,
  pullRequestMetricsSql,
  reviewMetricsSql,
  reviewersSql,
  slowestFirstReviewsSql,
  slowestMergesSql,
  type ExampleRange,
  type SeriesBounds,
  type SqlScope,
} from './metrics.sql';
import type { SignalExample } from './signal.types';

type Row = { bucket: string } & Record<string, number | string | null>;

interface CommitAuthorRow {
  bucket: string;
  author_key: string | null;
  n: number;
}

interface ExampleRow {
  number: number | null;
  sha: string | null;
  title: string | null;
  author: string | null;
  value: number;
}

interface ExampleSpec {
  sql: Prisma.Sql;
  kind: SignalExample['kind'];
  unit: FactUnit;
}

const MAX_EXAMPLES = 50;
const SHORT_SHA = 7;

/** Which evidence backs each metric, and in which unit. */
function exampleSpec(
  scope: SqlScope,
  metric: MetricName,
  range: ExampleRange,
  entity: string | undefined,
): ExampleSpec {
  const pr = (sql: Prisma.Sql, unit: FactUnit): ExampleSpec => ({
    sql,
    kind: 'pull_request',
    unit,
  });
  const issue = (sql: Prisma.Sql): ExampleSpec => ({
    sql,
    kind: 'issue',
    unit: 'hours',
  });
  switch (metric) {
    case 'time_to_first_review_p50_h':
      return pr(slowestFirstReviewsSql(scope, range), 'hours');
    case 'time_to_merge_p50_h':
      return pr(slowestMergesSql(scope, range), 'hours');
    case 'prs_opened':
      return pr(prsBySizeSql(scope, 'opened', range), 'lines');
    case 'prs_merged':
      return pr(prsBySizeSql(scope, 'merged', range), 'lines');
    case 'prs_closed_unmerged':
      return pr(prsBySizeSql(scope, 'closed_unmerged', range), 'lines');
    case 'reviews_submitted':
      return pr(
        mostReviewedSql(scope, range, { approvalsOnly: false }),
        'count',
      );
    case 'approvals':
      return pr(
        mostReviewedSql(scope, range, { approvalsOnly: true }),
        'count',
      );
    case 'review_concentration_top1':
    case 'review_concentration_hhi':
      return pr(
        mostReviewedSql(scope, range, {
          approvalsOnly: false,
          reviewer: entity,
        }),
        'count',
      );
    case 'issues_opened':
      return issue(newestIssuesSql(scope, range));
    case 'issues_closed':
    case 'issue_time_to_close_p50_h':
      return issue(longestClosedIssuesSql(scope, range));
    case 'commits':
    case 'active_authors':
    case 'bus_factor_50':
      return {
        sql: largestCommitsSql(scope, range),
        kind: 'commit',
        unit: 'lines',
      };
  }
}

function toExample(
  q: MetricsQuery,
  spec: ExampleSpec,
  row: ExampleRow,
): SignalExample {
  const base = `https://github.com/${q.owner}/${q.repo}`;
  if (spec.kind === 'commit') {
    const sha = row.sha ?? '';
    const ref = sha.slice(0, SHORT_SHA);
    return {
      kind: 'commit',
      ref,
      // Commit messages are not stored; the short sha is the best title.
      title: `Commit ${ref}`,
      author: row.author,
      value: row.value,
      unit: spec.unit,
      url: `${base}/commit/${sha}`,
    };
  }
  const path = spec.kind === 'issue' ? 'issues' : 'pull';
  return {
    kind: spec.kind,
    ref: `#${row.number}`,
    title: row.title ?? '',
    author: row.author,
    value: row.value,
    unit: spec.unit,
    url: `${base}/${path}/${row.number}`,
  };
}

function scopeOf(q: MetricsQuery): SqlScope {
  return {
    repositoryId: q.repositoryId,
    window: q.window,
    includeBots: q.includeBots,
  };
}

function seriesOf(buckets: BucketSpec[], q: MetricsQuery): SeriesBounds {
  return {
    first: buckets[0].start.toISOString(),
    last: buckets[buckets.length - 1].start.toISOString(),
    size: q.size,
  };
}

/** Throws when SQL produced a bucket key that buildBuckets did not. */
function assertKeys(rows: { bucket: string }[], buckets: BucketSpec[]): void {
  const keys = new Set(buckets.map((b) => b.key));
  for (const row of rows) {
    if (!keys.has(row.bucket)) {
      throw new Error(`SQL bucket ${row.bucket} not in buildBuckets output`);
    }
  }
}

/** Indexes SQL rows by bucket key (O(buckets)). */
function byKey<T extends { bucket: string }>(
  rows: T[],
  buckets: BucketSpec[],
): Map<string, T> {
  assertKeys(rows, buckets);
  return new Map(rows.map((row) => [row.bucket, row]));
}

/** Smallest k such that the top-k authors cover >= 50% of commits. */
function busFactor(countsDesc: number[]): number | null {
  const total = countsDesc.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  let covered = 0;
  for (let k = 0; k < countsDesc.length; k++) {
    covered += countsDesc[k];
    if (covered * 2 >= total) return k + 1;
  }
  return countsDesc.length;
}

@Injectable()
export class MetricsRepository {
  constructor(private readonly prisma: PrismaService) {}

  private run<T>(sql: Prisma.Sql): Promise<T[]> {
    return this.prisma.$queryRaw<T[]>(sql);
  }

  async bucketMetrics(q: MetricsQuery): Promise<BucketMetricsRow[]> {
    const buckets = buildBuckets(q.window, q.size);
    if (buckets.length === 0) return [];
    const scope = scopeOf(q);
    const s = seriesOf(buckets, q);
    const [prs, reviews, issues, commits] = await Promise.all([
      this.run<Row>(pullRequestMetricsSql(scope, s)),
      this.run<Row>(reviewMetricsSql(scope, s)),
      this.run<Row>(issueMetricsSql(scope, s)),
      this.run<CommitAuthorRow>(commitAuthorsSql(scope, s)),
    ]);
    const families = [prs, reviews, issues].map((rows) => byKey(rows, buckets));

    assertKeys(commits, buckets);
    const authors = new Map<string, number[]>();
    for (const row of commits) {
      const list = authors.get(row.bucket) ?? [];
      if (row.author_key !== null) list.push(row.n);
      authors.set(row.bucket, list);
    }

    return buckets.map((b) => {
      const merged: Record<string, number | string | null> = {};
      for (const family of families) Object.assign(merged, family.get(b.key));
      const counts = (authors.get(b.key) ?? []).sort((x, y) => y - x);
      const out = { bucket: b.key } as BucketMetricsRow;
      for (const m of METRIC_NAMES) {
        out[m] = (merged[m] as number | null) ?? null;
      }
      out.commits = counts.reduce((a, c) => a + c, 0);
      out.active_authors = counts.length;
      out.bus_factor_50 = busFactor(counts);
      out.top_reviewer = (merged.top_reviewer as string | null) ?? null;
      return out;
    });
  }

  async leaderboards(q: MetricsQuery): Promise<Leaderboards> {
    const scope = scopeOf(q);
    const [contributors, reviewers, mergers] = await Promise.all([
      this.run<Leaderboards['contributors'][number]>(contributorsSql(scope)),
      this.run<Leaderboards['reviewers'][number]>(reviewersSql(scope)),
      this.run<Leaderboards['mergers'][number]>(mergersSql(scope)),
    ]);
    return { contributors, reviewers, mergers };
  }

  async bucketExamples(q: BucketExamplesQuery): Promise<SignalExample[]> {
    const key = bucketKey(q.bucketStart, q.size);
    const bucket = buildBuckets(q.window, q.size).find((b) => b.key === key);
    if (!bucket || !(q.limit >= 1)) return [];
    const range = {
      from: new Date(Math.max(bucket.start.getTime(), q.window.from.getTime())),
      to: new Date(Math.min(bucket.end.getTime(), q.window.to.getTime())),
      limit: Math.min(Math.floor(q.limit), MAX_EXAMPLES),
    };
    const spec = exampleSpec(scopeOf(q), q.metric, range, q.entity);
    const rows = await this.run<ExampleRow>(spec.sql);
    return rows.map((row) => toExample(q, spec, row));
  }

  /**
   * The stored login matching `login` case-insensitively (GitHub logins are
   * case-insensitive), or null when no such actor exists.
   */
  async resolveLogin(login: string): Promise<string | null> {
    const actor = await this.prisma.actor.findFirst({
      where: { login: { equals: login, mode: 'insensitive' } },
      orderBy: { id: 'asc' },
      select: { login: true },
    });
    return actor?.login ?? null;
  }

  /** Per-bucket activity for a stored login (resolve it with resolveLogin). */
  async contributorActivity(
    q: MetricsQuery & { login: string },
  ): Promise<ContributorActivityRow[]> {
    const buckets = buildBuckets(q.window, q.size);
    if (buckets.length === 0) return [];
    const rows = await this.run<ContributorActivityRow>(
      contributorActivitySql(scopeOf(q), seriesOf(buckets, q), q.login),
    );
    const map = byKey(rows, buckets);
    return buckets.map(
      (b) =>
        map.get(b.key) ?? {
          bucket: b.key,
          prs_opened: 0,
          prs_merged: 0,
          reviews_given: 0,
          commits: 0,
        },
    );
  }
}
