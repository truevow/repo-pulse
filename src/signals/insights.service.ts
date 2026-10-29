import { Inject, Injectable } from '@nestjs/common';
import type { Repository } from '@prisma/client';
import { ProblemException } from '../common/problem.exception';
import { ENV, type Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildBuckets,
  parseWindow,
  type BucketSpec,
  type Window,
} from './buckets';
import { runDetectors } from './detectors/run-detectors';
import type { InsightsQuery } from './dto';
import type { InsightsBucket, InsightsResponse } from './insights.types';
import type {
  BucketMetricsRow,
  Leaderboards,
  MetricsQuery,
} from './leaderboards.types';
import { METRIC_NAMES, type MetricName } from './metric-names';
import {
  DETECTOR_PARAMETERS,
  type ConcentrationRow,
  type SeriesPoint,
  type Signal,
} from './signal.types';
import { MetricsRepository } from './metrics.repository';

const EXAMPLE_LIMIT = 5;

const PR_METRICS: ReadonlySet<MetricName> = new Set<MetricName>([
  'prs_opened',
  'prs_merged',
  'prs_closed_unmerged',
  'time_to_first_review_p50_h',
  'time_to_merge_p50_h',
  'reviews_submitted',
  'approvals',
  'review_concentration_top1',
  'review_concentration_hhi',
]);

const ISSUE_METRICS: ReadonlySet<MetricName> = new Set<MetricName>([
  'issues_opened',
  'issues_closed',
  'issue_time_to_close_p50_h',
]);

type Coverage = InsightsResponse['coverage'];
type Availability = InsightsResponse['availability'];

/** Bucket spec plus its response metrics and whether coverage spans it. */
interface ResolvedBucket {
  spec: BucketSpec;
  metrics: InsightsBucket['metrics'];
  topReviewer: string | null;
  covered: boolean;
}

const isoOrNull = (d: Date | null): string | null => d?.toISOString() ?? null;

function coverageOf(repo: Repository, window: Window): Coverage {
  const { coveredFrom, coveredTo } = repo;
  const partial =
    !coveredFrom ||
    !coveredTo ||
    window.from < coveredFrom ||
    window.to > coveredTo;
  return {
    from: isoOrNull(coveredFrom),
    to: isoOrNull(coveredTo),
    partial,
    lastSyncedAt: isoOrNull(repo.lastSyncedAt),
  };
}

function availabilityOf(repo: Repository): Availability {
  return {
    pullRequests: repo.hasPullRequests ? 'available' : 'unavailable',
    issues: repo.hasIssuesEnabled ? 'available' : 'unavailable',
    commits: 'available',
  };
}

function unavailableMetrics(a: Availability): ReadonlySet<MetricName> {
  return new Set([
    ...(a.pullRequests === 'unavailable' ? PR_METRICS : []),
    ...(a.issues === 'unavailable' ? ISSUE_METRICS : []),
  ]);
}

/** True when the in-window part of the bucket lies inside the synced range. */
function isCovered(
  spec: BucketSpec,
  window: Window,
  repo: Repository,
): boolean {
  if (!repo.coveredFrom || !repo.coveredTo) return false;
  const start = Math.max(spec.start.getTime(), window.from.getTime());
  const end = Math.min(spec.end.getTime(), window.to.getTime());
  return start >= repo.coveredFrom.getTime() && end <= repo.coveredTo.getTime();
}

function resolveBuckets(
  specs: BucketSpec[],
  rows: BucketMetricsRow[],
  unavailable: ReadonlySet<MetricName>,
  isCoveredBucket: (spec: BucketSpec) => boolean,
): ResolvedBucket[] {
  const byKey = new Map(rows.map((r) => [r.bucket, r]));
  return specs.map((spec) => {
    // An unsynced bucket has no data: its SQL zeros are not real zeros.
    const covered = isCoveredBucket(spec);
    const row = covered ? byKey.get(spec.key) : undefined;
    const metrics = Object.fromEntries(
      METRIC_NAMES.map((m) => [
        m,
        unavailable.has(m) ? null : (row?.[m] ?? null),
      ]),
    ) as InsightsBucket['metrics'];
    return {
      spec,
      metrics,
      topReviewer: row?.top_reviewer ?? null,
      covered,
    };
  });
}

/** Buckets outside coverage hold no data, so detectors treat them like partial ones. */
const incomplete = (b: ResolvedBucket): boolean => b.spec.partial || !b.covered;

function seriesOf(
  buckets: ResolvedBucket[],
  unavailable: ReadonlySet<MetricName>,
): Partial<Record<MetricName, SeriesPoint[]>> {
  const series: Partial<Record<MetricName, SeriesPoint[]>> = {};
  for (const m of METRIC_NAMES) {
    if (unavailable.has(m)) continue;
    series[m] = buckets.map((b) => ({
      bucket: b.spec.key,
      value: b.metrics[m],
      partial: incomplete(b),
    }));
  }
  return series;
}

function concentrationOf(
  buckets: ResolvedBucket[],
  availability: Availability,
): ConcentrationRow[] {
  if (availability.pullRequests === 'unavailable') return [];
  return buckets.map((b) => ({
    bucket: b.spec.key,
    partial: incomplete(b),
    reviews: b.metrics.reviews_submitted ?? 0,
    top1Share: b.metrics.review_concentration_top1,
    topLogin: b.topReviewer,
  }));
}

function filterLeaderboards(
  boards: Leaderboards,
  availability: Availability,
): Leaderboards {
  if (availability.pullRequests === 'available') return boards;
  return { contributors: boards.contributors, reviewers: [], mergers: [] };
}

function toResponseBucket(b: ResolvedBucket): InsightsBucket {
  return {
    key: b.spec.key,
    start: b.spec.start.toISOString(),
    end: b.spec.end.toISOString(),
    partial: b.spec.partial,
    covered: b.covered,
    metrics: b.metrics,
  };
}

@Injectable()
export class InsightsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsRepository,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async getInsights(
    owner: string,
    repo: string,
    q: InsightsQuery,
  ): Promise<InsightsResponse> {
    const repository = await this.findRepository(owner, repo);
    const window = parseWindow(
      { from: q.from, to: q.to },
      new Date(),
      this.env.SYNC_MAX_WEEKS,
    );
    const mq: MetricsQuery = {
      repositoryId: repository.id,
      owner: repository.owner,
      repo: repository.name,
      window,
      size: q.bucket,
      includeBots: q.includeBots,
    };
    const availability = availabilityOf(repository);
    const unavailable = unavailableMetrics(availability);

    const [rows, leaderboards] = await Promise.all([
      this.metrics.bucketMetrics(mq),
      this.metrics.leaderboards(mq),
    ]);
    const buckets = resolveBuckets(
      buildBuckets(window, q.bucket),
      rows,
      unavailable,
      (spec) => isCovered(spec, window, repository),
    );
    const detected = runDetectors({
      size: q.bucket,
      series: seriesOf(buckets, unavailable),
      concentration: concentrationOf(buckets, availability),
    });
    const signals = await this.withExamples(mq, detected);

    return {
      repository: {
        owner: repository.owner,
        name: repository.name,
        defaultBranch: repository.defaultBranch,
        url: `https://github.com/${repository.owner}/${repository.name}`,
      },
      window: { from: window.from.toISOString(), to: window.to.toISOString() },
      bucket: q.bucket,
      includeBots: q.includeBots,
      coverage: coverageOf(repository, window),
      availability,
      buckets: buckets.map(toResponseBucket),
      leaderboards: filterLeaderboards(leaderboards, availability),
      signals,
      parameters: DETECTOR_PARAMETERS,
    };
  }

  /** Case-insensitive: GitHub names are, and users type any casing. */
  private async findRepository(
    owner: string,
    name: string,
  ): Promise<Repository> {
    const repository = await this.prisma.repository.findFirst({
      where: {
        owner: { equals: owner, mode: 'insensitive' },
        name: { equals: name, mode: 'insensitive' },
      },
      orderBy: { id: 'asc' },
    });
    if (!repository) {
      throw new ProblemException({
        status: 404,
        type: 'repo-not-synced',
        title: 'Repository not synced',
        detail: `POST /api/v1/repos/${owner}/${name}/sync first`,
      });
    }
    return repository;
  }

  private withExamples(mq: MetricsQuery, signals: Signal[]): Promise<Signal[]> {
    return Promise.all(
      signals.map(async (signal) => ({
        ...signal,
        examples: await this.metrics.bucketExamples({
          ...mq,
          metric: signal.metric,
          bucketStart: new Date(signal.bucket),
          limit: EXAMPLE_LIMIT,
          entity: signal.entity ?? undefined,
        }),
      })),
    );
  }
}
