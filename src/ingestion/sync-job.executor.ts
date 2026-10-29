import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, Repository, SyncJob } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { GITHUB_CLIENT, type GitHubClient } from '../github/github.client';
import { errorLogFields, GitHubError } from '../github/github.errors';
import type {
  CommitsResult,
  IssuesResult,
  PageInfo,
  PullRequestReviewsResult,
  PullRequestsResult,
  RateLimit,
} from '../github/github.types';
import {
  COMMITS_QUERY,
  ISSUES_QUERY,
  PULL_REQUEST_REVIEWS_QUERY,
  PULL_REQUESTS_QUERY,
} from '../github/queries';
import { PrismaService } from '../prisma/prisma.service';
import {
  upsertCommits,
  upsertIssues,
  upsertPullRequests,
  upsertReviews,
  type ReviewOverflow,
} from './upserts';

type Counter = 'pullRequests' | 'reviews' | 'issues' | 'commits';
type Counts = Partial<Record<Counter, number>>;
type Tx = Prisma.TransactionClient;

interface Connection<N> {
  pageInfo: PageInfo;
  nodes: N[];
}

interface JobContext {
  jobId: string;
  repositoryId: number;
  owner: string;
  name: string;
  since: Date;
  /** Commits are filtered by committed date, not update time; see ingest(). */
  commitsSince: Date;
  commitsUntil: Date;
}

/** Per-page transactions upsert up to 50 PRs with 30 reviews each. */
const PAGE_TX = { timeout: 60_000 };

function lost(): GitHubError {
  return new GitHubError('not_found', 'Repository disappeared during sync');
}

/** Pages one sync job from GitHub into Postgres and records the outcome on the job row. */
@Injectable()
export class SyncJobExecutor {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(GITHUB_CLIENT) private readonly github: GitHubClient,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SyncJobExecutor.name);
  }

  async run(jobId: string): Promise<void> {
    const startedAt = new Date();
    const job = await this.prisma.syncJob.update({
      where: { id: jobId },
      data: { status: 'running', startedAt },
      include: { repository: true },
    });
    try {
      await this.ingest(job, job.repository);
      await this.succeed(job, startedAt);
      this.logger.info(
        {
          jobId,
          durationMs: Date.now() - startedAt.getTime(),
          rssMb: Math.round(process.memoryUsage().rss / 1_048_576),
          rateLimitRemaining: this.github.lastRateLimit?.remaining ?? null,
        },
        'sync job succeeded',
      );
    } catch (err) {
      this.logger.error({ jobId, ...errorLogFields(err) }, 'sync job failed');
      await this.prisma.syncJob.update({
        where: { id: jobId },
        data: {
          status: 'failed',
          error: err instanceof GitHubError ? err.kind : 'internal',
          finishedAt: new Date(),
        },
      });
    }
  }

  private async ingest(job: SyncJob, repo: Repository): Promise<void> {
    const incremental = job.mode === 'incremental';
    const backfill = job.mode === 'backfill';
    const ctx: JobContext = {
      jobId: job.id,
      repositoryId: repo.id,
      owner: repo.owner,
      name: repo.name,
      since: incremental
        ? (repo.lastSyncedAt ?? job.requestedFrom)
        : job.requestedFrom,
      // The previous job fetched commits only up to its requestedTo, which is
      // before its startedAt (lastSyncedAt), so resume from the coverage end.
      commitsSince: incremental
        ? (repo.coveredTo ?? repo.lastSyncedAt ?? job.requestedFrom)
        : job.requestedFrom,
      // succeed() extends coverage to the old coveredTo, so a backfill that
      // ends before the old coverage starts must also fetch the gap up to it.
      commitsUntil:
        backfill && repo.coveredFrom && repo.coveredFrom > job.requestedTo
          ? repo.coveredFrom
          : job.requestedTo,
    };
    if (repo.hasPullRequests) await this.syncPullRequests(ctx);
    if (repo.hasIssuesEnabled) await this.syncIssues(ctx);
    await this.syncCommits(ctx);
  }

  private async succeed(job: SyncJob, startedAt: Date): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const repo = await tx.repository.findUniqueOrThrow({
        where: { id: job.repositoryId },
      });
      const reachedTo = Math.min(job.requestedTo.getTime(), now.getTime());
      const coveredFrom = Math.min(
        repo.coveredFrom?.getTime() ?? Infinity,
        job.requestedFrom.getTime(),
      );
      const coveredTo = Math.max(
        repo.coveredTo?.getTime() ?? -Infinity,
        reachedTo,
      );
      await tx.repository.update({
        where: { id: repo.id },
        data: {
          coveredFrom: new Date(coveredFrom),
          coveredTo: new Date(coveredTo),
          lastSyncedAt: startedAt,
        },
      });
      await tx.syncJob.update({
        where: { id: job.id },
        data: { status: 'succeeded', finishedAt: now },
      });
    });
  }

  private async syncPullRequests(ctx: JobContext): Promise<void> {
    await this.pageByUpdatedAt(
      ctx,
      PULL_REQUESTS_QUERY,
      (r: PullRequestsResult) => r.repository?.pullRequests,
      async (nodes, rateLimit) => {
        const { overflow } = await this.prisma.$transaction(async (tx) => {
          const res = await upsertPullRequests(tx, ctx.repositoryId, nodes);
          await this.record(tx, ctx.jobId, res, rateLimit);
          return res;
        }, PAGE_TX);
        for (const o of overflow) await this.syncReviewOverflow(ctx, o);
      },
    );
  }

  /** Follows a PR's reviews beyond the nested page; no stop rule (reviews are per PR). */
  private async syncReviewOverflow(
    ctx: JobContext,
    o: ReviewOverflow,
  ): Promise<void> {
    let cursor: string | null = o.after;
    while (cursor) {
      const result: PullRequestReviewsResult = await this.github.query(
        PULL_REQUEST_REVIEWS_QUERY,
        { id: o.githubId, cursor },
      );
      if (!result.node) throw lost();
      const { nodes, pageInfo } = result.node.reviews;
      await this.prisma.$transaction(async (tx) => {
        const reviews = await upsertReviews(tx, o.githubId, nodes);
        await this.record(tx, ctx.jobId, { reviews }, result.rateLimit);
      }, PAGE_TX);
      cursor = pageInfo.hasNextPage ? pageInfo.endCursor : null;
    }
  }

  private async syncIssues(ctx: JobContext): Promise<void> {
    await this.pageByUpdatedAt(
      ctx,
      ISSUES_QUERY,
      (r: IssuesResult) => r.repository?.issues,
      (nodes, rateLimit) =>
        this.prisma.$transaction(async (tx) => {
          const issues = await upsertIssues(tx, ctx.repositoryId, nodes);
          await this.record(tx, ctx.jobId, { issues }, rateLimit);
        }, PAGE_TX),
    );
  }

  /** Commit history is filtered by GitHub (`since`/`until`), so it pages to the end. */
  private async syncCommits(ctx: JobContext): Promise<void> {
    let cursor: string | null = null;
    do {
      const result: CommitsResult = await this.github.query(COMMITS_QUERY, {
        owner: ctx.owner,
        name: ctx.name,
        since: ctx.commitsSince.toISOString(),
        until: ctx.commitsUntil.toISOString(),
        cursor,
      });
      if (!result.repository) throw lost();
      const history = result.repository.defaultBranchRef?.target.history;
      const nodes = history?.nodes ?? [];
      await this.prisma.$transaction(async (tx) => {
        const commits = await upsertCommits(tx, ctx.repositoryId, nodes);
        await this.record(tx, ctx.jobId, { commits }, result.rateLimit);
      }, PAGE_TX);
      cursor = history?.pageInfo.hasNextPage
        ? history.pageInfo.endCursor
        : null;
    } while (cursor);
  }

  /**
   * Pages a connection ordered by UPDATED_AT DESC, storing only nodes updated
   * at or after `since`, and stops after the page whose last node is older.
   */
  private async pageByUpdatedAt<
    R extends { rateLimit?: RateLimit },
    N extends { updatedAt: string },
  >(
    ctx: JobContext,
    document: string,
    connection: (result: R) => Connection<N> | undefined,
    store: (nodes: N[], rateLimit: RateLimit | undefined) => Promise<void>,
  ): Promise<void> {
    const since = ctx.since.getTime();
    let cursor: string | null = null;
    for (;;) {
      const result: R = await this.github.query<R>(document, {
        owner: ctx.owner,
        name: ctx.name,
        cursor,
      });
      const page = connection(result);
      if (!page) throw lost();
      const { nodes, pageInfo } = page;
      const fresh = nodes.filter((n) => Date.parse(n.updatedAt) >= since);
      await store(fresh, result.rateLimit);
      const last = nodes.at(-1);
      if (
        !pageInfo.hasNextPage ||
        !last ||
        Date.parse(last.updatedAt) < since
      ) {
        return;
      }
      cursor = pageInfo.endCursor;
    }
  }

  private async record(
    tx: Tx,
    jobId: string,
    counts: Counts,
    rateLimit: RateLimit | undefined,
  ): Promise<void> {
    const remaining =
      rateLimit?.remaining ?? this.github.lastRateLimit?.remaining;
    await tx.syncJob.update({
      where: { id: jobId },
      data: {
        pullRequests: { increment: counts.pullRequests ?? 0 },
        reviews: { increment: counts.reviews ?? 0 },
        issues: { increment: counts.issues ?? 0 },
        commits: { increment: counts.commits ?? 0 },
        ...(remaining !== undefined && { rateLimitRemaining: remaining }),
      },
    });
  }
}
