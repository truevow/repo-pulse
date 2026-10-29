/**
 * SQL builders for per-bucket metrics, leaderboards, examples and contributor
 * activity. Query builders only: every function returns a `Prisma.Sql` that
 * `metrics.repository.ts` executes. Values are always bound parameters; the
 * only spliced fragments are the literal ones defined in this file.
 *
 * Counting rules (applied identically everywhere):
 * - Window: a row counts only when the timestamp that defines its metric lies
 *   in [window.from, window.to): createdAt for "opened", mergedAt for merge
 *   metrics, closedAt for close metrics, submittedAt for review metrics, the
 *   first review's submittedAt for first-review latency, committedDate for
 *   commits. Buckets are `date_trunc('week'|'day', ts AT TIME ZONE 'UTC')`
 *   (ISO Monday weeks), left-joined onto a generate_series of bucket starts
 *   computed in TypeScript by `buildBuckets`, so empty buckets are present.
 * - Reviews: PENDING reviews are ignored everywhere; DISMISSED count as
 *   submitted. Self-reviews (review author IS NOT DISTINCT FROM the PR author)
 *   are excluded from every review metric, examples and the reviewers board.
 * - Bots: with includeBots = false, reviews by bot actors are excluded from
 *   every review metric (reviews_submitted, approvals, first-review latency,
 *   concentration) and bot actors are excluded from the leaderboards.
 *   PR, issue and commit counts (and active_authors / bus_factor_50) always
 *   include everything, bots included.
 */
import { Prisma } from '@prisma/client';
import type { BucketSize, Window } from './buckets';

export interface SeriesBounds {
  /** ISO timestamps of the first and last bucket start (from buildBuckets). */
  first: string;
  last: string;
  size: BucketSize;
}

export interface SqlScope {
  repositoryId: number;
  window: Window;
  includeBots: boolean;
}

const iso = (d: Date): string => d.toISOString();

/** Bucket start (timestamp without time zone, UTC) of a timestamptz column. */
function bucketOf(size: BucketSize, column: Prisma.Sql): Prisma.Sql {
  return size === 'week'
    ? Prisma.sql`date_trunc('week', ${column} AT TIME ZONE 'UTC')`
    : Prisma.sql`date_trunc('day', ${column} AT TIME ZONE 'UTC')`;
}

function series(s: SeriesBounds): Prisma.Sql {
  const step =
    s.size === 'week'
      ? Prisma.sql`interval '1 week'`
      : Prisma.sql`interval '1 day'`;
  return Prisma.sql`series AS (
    SELECT gs AS bucket_start
    FROM generate_series(
      (${s.first}::timestamptz AT TIME ZONE 'UTC'),
      (${s.last}::timestamptz AT TIME ZONE 'UTC'),
      ${step}
    ) AS gs
  )`;
}

function inRange(column: Prisma.Sql, from: Date, to: Date): Prisma.Sql {
  return Prisma.sql`${column} >= ${iso(from)}::timestamptz AND ${column} < ${iso(to)}::timestamptz`;
}

function hoursBetween(later: Prisma.Sql, earlier: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(EXTRACT(EPOCH FROM (${later} - ${earlier})) / 3600.0)::float8`;
}

function median(hours: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(percentile_cont(0.5) WITHIN GROUP (ORDER BY ${hours}))::float8`;
}

const KEY = Prisma.sql`to_char(s.bucket_start, 'YYYY-MM-DD')`;

const PR_CREATED = Prisma.sql`pr."createdAt"`;
const PR_MERGED = Prisma.sql`pr."mergedAt"`;
const PR_CLOSED = Prisma.sql`pr."closedAt"`;
const REVIEW_AT = Prisma.sql`r."submittedAt"`;
const ISSUE_CREATED = Prisma.sql`i."createdAt"`;
const ISSUE_CLOSED = Prisma.sql`i."closedAt"`;
const COMMITTED = Prisma.sql`c."committedDate"`;

/**
 * Counted reviews (any time): non-PENDING, non-self, bot-filtered, with the
 * PR's creation time. Columns: pr_id, number, title, pr_author, login, state,
 * at, pr_created.
 */
function countedReviews(scope: SqlScope): Prisma.Sql {
  return Prisma.sql`counted_reviews AS (
    SELECT r."pullRequestId" AS pr_id, pr.number, pr.title,
           pa.login AS pr_author, a.login, r.state,
           r."submittedAt" AS at, pr."createdAt" AS pr_created
    FROM reviews r
    JOIN pull_requests pr ON pr.id = r."pullRequestId"
    LEFT JOIN actors a ON a.id = r."authorId"
    LEFT JOIN actors pa ON pa.id = pr."authorId"
    WHERE pr."repositoryId" = ${scope.repositoryId}
      AND r.state <> 'PENDING'
      AND r."authorId" IS DISTINCT FROM pr."authorId"
      AND (${scope.includeBots}::boolean OR NOT COALESCE(a."isBot", false))
  )`;
}

/** First counted review per PR: pr_id, number, title, pr_author, at, hours. */
const FIRST_REVIEWS = Prisma.sql`first_reviews AS (
    SELECT pr_id, number, title, pr_author, MIN(at) AS at,
           ${hoursBetween(Prisma.sql`MIN(at)`, Prisma.sql`MIN(pr_created)`)} AS hours
    FROM counted_reviews
    GROUP BY pr_id, number, title, pr_author
  )`;

// ---------------------------------------------------------------------------
// Per-bucket families
// ---------------------------------------------------------------------------

/** bucket, prs_opened, prs_merged, prs_closed_unmerged, time_to_merge_p50_h */
export function pullRequestMetricsSql(
  scope: SqlScope,
  s: SeriesBounds,
): Prisma.Sql {
  const { from, to } = scope.window;
  const repo = Prisma.sql`pr."repositoryId" = ${scope.repositoryId}`;
  return Prisma.sql`
    WITH ${series(s)},
    opened AS (
      SELECT ${bucketOf(s.size, PR_CREATED)} AS b, count(*)::int AS n
      FROM pull_requests pr
      WHERE ${repo} AND ${inRange(PR_CREATED, from, to)}
      GROUP BY 1
    ),
    merged AS (
      SELECT ${bucketOf(s.size, PR_MERGED)} AS b, count(*)::int AS n,
             ${median(hoursBetween(PR_MERGED, PR_CREATED))} AS p50
      FROM pull_requests pr
      WHERE ${repo} AND ${inRange(PR_MERGED, from, to)}
      GROUP BY 1
    ),
    closed AS (
      SELECT ${bucketOf(s.size, PR_CLOSED)} AS b, count(*)::int AS n
      FROM pull_requests pr
      WHERE ${repo} AND pr."mergedAt" IS NULL AND ${inRange(PR_CLOSED, from, to)}
      GROUP BY 1
    )
    SELECT ${KEY} AS bucket,
           COALESCE(o.n, 0)::int AS prs_opened,
           COALESCE(m.n, 0)::int AS prs_merged,
           COALESCE(c.n, 0)::int AS prs_closed_unmerged,
           m.p50 AS time_to_merge_p50_h
    FROM series s
    LEFT JOIN opened o ON o.b = s.bucket_start
    LEFT JOIN merged m ON m.b = s.bucket_start
    LEFT JOIN closed c ON c.b = s.bucket_start
    ORDER BY s.bucket_start`;
}

/**
 * bucket, reviews_submitted, approvals, time_to_first_review_p50_h,
 * review_concentration_top1, review_concentration_hhi, top_reviewer
 */
export function reviewMetricsSql(scope: SqlScope, s: SeriesBounds): Prisma.Sql {
  const { from, to } = scope.window;
  const at = Prisma.sql`at`;
  return Prisma.sql`
    WITH ${series(s)},
    ${countedReviews(scope)},
    ${FIRST_REVIEWS},
    in_window AS (
      SELECT ${bucketOf(s.size, at)} AS b, login, state
      FROM counted_reviews
      WHERE ${inRange(at, from, to)}
    ),
    totals AS (
      SELECT b, count(*)::int AS n,
             (count(*) FILTER (WHERE state = 'APPROVED'))::int AS approvals
      FROM in_window GROUP BY b
    ),
    latency AS (
      SELECT ${bucketOf(s.size, at)} AS b, ${median(Prisma.sql`hours`)} AS p50
      FROM first_reviews
      WHERE ${inRange(at, from, to)}
      GROUP BY 1
    ),
    per_reviewer AS (
      SELECT b, login, count(*)::int AS cnt FROM in_window GROUP BY b, login
    ),
    concentration AS (
      SELECT b,
             (max(cnt)::float8 / sum(cnt)::float8) AS top1,
             (sum(cnt * cnt)::float8 / (sum(cnt)::float8 * sum(cnt)::float8)) AS hhi
      FROM per_reviewer GROUP BY b
    ),
    top AS (
      SELECT DISTINCT ON (b) b, login
      FROM per_reviewer
      ORDER BY b, cnt DESC, login COLLATE "C"
    )
    SELECT ${KEY} AS bucket,
           COALESCE(t.n, 0)::int AS reviews_submitted,
           COALESCE(t.approvals, 0)::int AS approvals,
           l.p50 AS time_to_first_review_p50_h,
           c.top1 AS review_concentration_top1,
           c.hhi AS review_concentration_hhi,
           tp.login AS top_reviewer
    FROM series s
    LEFT JOIN totals t ON t.b = s.bucket_start
    LEFT JOIN latency l ON l.b = s.bucket_start
    LEFT JOIN concentration c ON c.b = s.bucket_start
    LEFT JOIN top tp ON tp.b = s.bucket_start
    ORDER BY s.bucket_start`;
}

/** bucket, issues_opened, issues_closed, issue_time_to_close_p50_h */
export function issueMetricsSql(scope: SqlScope, s: SeriesBounds): Prisma.Sql {
  const { from, to } = scope.window;
  const repo = Prisma.sql`i."repositoryId" = ${scope.repositoryId}`;
  return Prisma.sql`
    WITH ${series(s)},
    opened AS (
      SELECT ${bucketOf(s.size, ISSUE_CREATED)} AS b, count(*)::int AS n
      FROM issues i
      WHERE ${repo} AND ${inRange(ISSUE_CREATED, from, to)}
      GROUP BY 1
    ),
    closed AS (
      SELECT ${bucketOf(s.size, ISSUE_CLOSED)} AS b, count(*)::int AS n,
             ${median(hoursBetween(ISSUE_CLOSED, ISSUE_CREATED))} AS p50
      FROM issues i
      WHERE ${repo} AND ${inRange(ISSUE_CLOSED, from, to)}
      GROUP BY 1
    )
    SELECT ${KEY} AS bucket,
           COALESCE(o.n, 0)::int AS issues_opened,
           COALESCE(c.n, 0)::int AS issues_closed,
           c.p50 AS issue_time_to_close_p50_h
    FROM series s
    LEFT JOIN opened o ON o.b = s.bucket_start
    LEFT JOIN closed c ON c.b = s.bucket_start
    ORDER BY s.bucket_start`;
}

/**
 * One row per (bucket, author) with that author's commit count; empty buckets
 * yield one row with author_key NULL and n = 0. Unlinked commits (no GitHub
 * user) are one pseudo-author per distinct authorName.
 */
export function commitAuthorsSql(scope: SqlScope, s: SeriesBounds): Prisma.Sql {
  const { from, to } = scope.window;
  return Prisma.sql`
    WITH ${series(s)},
    per_author AS (
      SELECT ${bucketOf(s.size, COMMITTED)} AS b,
             COALESCE('id:' || c."authorId"::text, 'name:' || c."authorName") AS author_key,
             count(*)::int AS n
      FROM commits c
      WHERE c."repositoryId" = ${scope.repositoryId} AND ${inRange(COMMITTED, from, to)}
      GROUP BY 1, 2
    )
    SELECT ${KEY} AS bucket, p.author_key, COALESCE(p.n, 0)::int AS n
    FROM series s
    LEFT JOIN per_author p ON p.b = s.bucket_start
    ORDER BY s.bucket_start, p.n DESC`;
}

// ---------------------------------------------------------------------------
// Leaderboards (whole window, top 20)
// ---------------------------------------------------------------------------

const LEADERBOARD_LIMIT = 20;
const notBot = (includeBots: boolean, alias: Prisma.Sql) =>
  Prisma.sql`(${includeBots}::boolean OR NOT ${alias}."isBot")`;

export function contributorsSql(scope: SqlScope): Prisma.Sql {
  const { from, to } = scope.window;
  // linesChanged is float8 so a huge window cannot overflow int4 and still
  // arrives as a JS number.
  return Prisma.sql`
    WITH merged AS (
      SELECT pr."authorId" AS actor_id, count(*)::int AS n
      FROM pull_requests pr
      WHERE pr."repositoryId" = ${scope.repositoryId} AND pr."authorId" IS NOT NULL
        AND ${inRange(PR_MERGED, from, to)}
      GROUP BY 1
    ),
    authored AS (
      SELECT c."authorId" AS actor_id, count(*)::int AS n,
             sum(c.additions + c.deletions)::float8 AS lines
      FROM commits c
      WHERE c."repositoryId" = ${scope.repositoryId} AND c."authorId" IS NOT NULL
        AND ${inRange(COMMITTED, from, to)}
      GROUP BY 1
    ),
    ids AS (SELECT actor_id FROM merged UNION SELECT actor_id FROM authored)
    SELECT a.login,
           COALESCE(m.n, 0)::int AS "mergedPrs",
           COALESCE(c.n, 0)::int AS commits,
           COALESCE(c.lines, 0)::float8 AS "linesChanged"
    FROM ids
    JOIN actors a ON a.id = ids.actor_id
    LEFT JOIN merged m ON m.actor_id = ids.actor_id
    LEFT JOIN authored c ON c.actor_id = ids.actor_id
    WHERE ${notBot(scope.includeBots, Prisma.sql`a`)}
    ORDER BY "mergedPrs" DESC, a.login COLLATE "C"
    LIMIT ${LEADERBOARD_LIMIT}::int`;
}

export function reviewersSql(scope: SqlScope): Prisma.Sql {
  const { from, to } = scope.window;
  return Prisma.sql`
    WITH ${countedReviews(scope)}
    SELECT login, count(*)::int AS reviews,
           (count(*) FILTER (WHERE state = 'APPROVED'))::int AS approvals
    FROM counted_reviews
    WHERE login IS NOT NULL AND ${inRange(Prisma.sql`at`, from, to)}
    GROUP BY login
    ORDER BY reviews DESC, login COLLATE "C"
    LIMIT ${LEADERBOARD_LIMIT}::int`;
}

export function mergersSql(scope: SqlScope): Prisma.Sql {
  const { from, to } = scope.window;
  return Prisma.sql`
    SELECT a.login, count(*)::int AS "prsMerged"
    FROM pull_requests pr
    JOIN actors a ON a.id = pr."mergedById"
    WHERE pr."repositoryId" = ${scope.repositoryId}
      AND ${inRange(PR_MERGED, from, to)}
      AND ${notBot(scope.includeBots, Prisma.sql`a`)}
    GROUP BY a.login
    ORDER BY "prsMerged" DESC, a.login COLLATE "C"
    LIMIT ${LEADERBOARD_LIMIT}::int`;
}

// ---------------------------------------------------------------------------
// Bucket examples. Each returns rows { number, sha, title, author, value }.
// `range` is the bucket clipped to the window.
// ---------------------------------------------------------------------------

export interface ExampleRange {
  from: Date;
  to: Date;
  limit: number;
}

export type PrExampleKind = 'opened' | 'merged' | 'closed_unmerged';

/** PRs created / merged / closed-unmerged in range, largest by lines. */
export function prsBySizeSql(
  scope: SqlScope,
  kind: PrExampleKind,
  r: ExampleRange,
): Prisma.Sql {
  const filter =
    kind === 'opened'
      ? inRange(PR_CREATED, r.from, r.to)
      : kind === 'merged'
        ? inRange(PR_MERGED, r.from, r.to)
        : Prisma.sql`pr."mergedAt" IS NULL AND ${inRange(PR_CLOSED, r.from, r.to)}`;
  return Prisma.sql`
    SELECT pr.number, NULL::text AS sha, pr.title, a.login AS author,
           (pr.additions + pr.deletions)::float8 AS value
    FROM pull_requests pr
    LEFT JOIN actors a ON a.id = pr."authorId"
    WHERE pr."repositoryId" = ${scope.repositoryId} AND ${filter}
    ORDER BY value DESC, pr.number
    LIMIT ${r.limit}::int`;
}

/** PRs merged in range, slowest (creation -> merge) first. */
export function slowestMergesSql(scope: SqlScope, r: ExampleRange): Prisma.Sql {
  return Prisma.sql`
    SELECT pr.number, NULL::text AS sha, pr.title, a.login AS author,
           ${hoursBetween(PR_MERGED, PR_CREATED)} AS value
    FROM pull_requests pr
    LEFT JOIN actors a ON a.id = pr."authorId"
    WHERE pr."repositoryId" = ${scope.repositoryId} AND ${inRange(PR_MERGED, r.from, r.to)}
    ORDER BY value DESC, pr.number
    LIMIT ${r.limit}::int`;
}

/** PRs whose first counted review landed in range, slowest first. */
export function slowestFirstReviewsSql(
  scope: SqlScope,
  r: ExampleRange,
): Prisma.Sql {
  return Prisma.sql`
    WITH ${countedReviews(scope)},
    ${FIRST_REVIEWS}
    SELECT number, NULL::text AS sha, title, pr_author AS author, hours AS value
    FROM first_reviews
    WHERE ${inRange(Prisma.sql`at`, r.from, r.to)}
    ORDER BY value DESC, number
    LIMIT ${r.limit}::int`;
}

/**
 * PRs with the most counted reviews in range (approvals only when
 * `approvalsOnly`; one reviewer's reviews only when `reviewer` is set).
 */
export function mostReviewedSql(
  scope: SqlScope,
  r: ExampleRange,
  opts: { approvalsOnly: boolean; reviewer?: string },
): Prisma.Sql {
  const approved = opts.approvalsOnly
    ? Prisma.sql`AND state = 'APPROVED'`
    : Prisma.empty;
  const reviewer =
    opts.reviewer === undefined
      ? Prisma.empty
      : Prisma.sql`AND login = ${opts.reviewer}`;
  return Prisma.sql`
    WITH ${countedReviews(scope)}
    SELECT number, NULL::text AS sha, title, pr_author AS author,
           count(*)::float8 AS value
    FROM counted_reviews
    WHERE ${inRange(Prisma.sql`at`, r.from, r.to)} ${approved} ${reviewer}
    GROUP BY number, title, pr_author
    ORDER BY value DESC, number
    LIMIT ${r.limit}::int`;
}

/** Issues closed in range, longest open first (value = hours to close). */
export function longestClosedIssuesSql(
  scope: SqlScope,
  r: ExampleRange,
): Prisma.Sql {
  return Prisma.sql`
    SELECT i.number, NULL::text AS sha, i.title, a.login AS author,
           ${hoursBetween(ISSUE_CLOSED, ISSUE_CREATED)} AS value
    FROM issues i
    LEFT JOIN actors a ON a.id = i."authorId"
    WHERE i."repositoryId" = ${scope.repositoryId} AND ${inRange(ISSUE_CLOSED, r.from, r.to)}
    ORDER BY value DESC, i.number
    LIMIT ${r.limit}::int`;
}

/** Issues opened in range, newest first (value = age in hours at window end). */
export function newestIssuesSql(scope: SqlScope, r: ExampleRange): Prisma.Sql {
  const windowEnd = Prisma.sql`${iso(scope.window.to)}::timestamptz`;
  return Prisma.sql`
    SELECT i.number, NULL::text AS sha, i.title, a.login AS author,
           ${hoursBetween(windowEnd, ISSUE_CREATED)} AS value
    FROM issues i
    LEFT JOIN actors a ON a.id = i."authorId"
    WHERE i."repositoryId" = ${scope.repositoryId} AND ${inRange(ISSUE_CREATED, r.from, r.to)}
    ORDER BY i."createdAt" DESC, i.number DESC
    LIMIT ${r.limit}::int`;
}

/** Commits in range, largest by lines first (author falls back to authorName). */
export function largestCommitsSql(
  scope: SqlScope,
  r: ExampleRange,
): Prisma.Sql {
  return Prisma.sql`
    SELECT NULL::int AS number, c.sha, NULL::text AS title,
           COALESCE(a.login, c."authorName") AS author,
           (c.additions + c.deletions)::float8 AS value
    FROM commits c
    LEFT JOIN actors a ON a.id = c."authorId"
    WHERE c."repositoryId" = ${scope.repositoryId} AND ${inRange(COMMITTED, r.from, r.to)}
    ORDER BY value DESC, c.sha
    LIMIT ${r.limit}::int`;
}

// ---------------------------------------------------------------------------
// Contributor activity
// ---------------------------------------------------------------------------

/** bucket, prs_opened, prs_merged, reviews_given, commits for one login. */
export function contributorActivitySql(
  scope: SqlScope,
  s: SeriesBounds,
  login: string,
): Prisma.Sql {
  const { from, to } = scope.window;
  const repo = scope.repositoryId;
  const me = Prisma.sql`(SELECT id FROM actors WHERE login = ${login})`;
  return Prisma.sql`
    WITH ${series(s)},
    opened AS (
      SELECT ${bucketOf(s.size, PR_CREATED)} AS b, count(*)::int AS n
      FROM pull_requests pr
      WHERE pr."repositoryId" = ${repo} AND pr."authorId" = ${me}
        AND ${inRange(PR_CREATED, from, to)}
      GROUP BY 1
    ),
    merged AS (
      SELECT ${bucketOf(s.size, PR_MERGED)} AS b, count(*)::int AS n
      FROM pull_requests pr
      WHERE pr."repositoryId" = ${repo} AND pr."authorId" = ${me}
        AND ${inRange(PR_MERGED, from, to)}
      GROUP BY 1
    ),
    given AS (
      SELECT ${bucketOf(s.size, REVIEW_AT)} AS b, count(*)::int AS n
      FROM reviews r
      JOIN pull_requests pr ON pr.id = r."pullRequestId"
      WHERE pr."repositoryId" = ${repo} AND r."authorId" = ${me}
        AND r.state <> 'PENDING'
        AND r."authorId" IS DISTINCT FROM pr."authorId"
        AND ${inRange(REVIEW_AT, from, to)}
      GROUP BY 1
    ),
    authored AS (
      SELECT ${bucketOf(s.size, COMMITTED)} AS b, count(*)::int AS n
      FROM commits c
      WHERE c."repositoryId" = ${repo} AND c."authorId" = ${me}
        AND ${inRange(COMMITTED, from, to)}
      GROUP BY 1
    )
    SELECT ${KEY} AS bucket,
           COALESCE(o.n, 0)::int AS prs_opened,
           COALESCE(m.n, 0)::int AS prs_merged,
           COALESCE(g.n, 0)::int AS reviews_given,
           COALESCE(c.n, 0)::int AS commits
    FROM series s
    LEFT JOIN opened o ON o.b = s.bucket_start
    LEFT JOIN merged m ON m.b = s.bucket_start
    LEFT JOIN given g ON g.b = s.bucket_start
    LEFT JOIN authored c ON c.b = s.bucket_start
    ORDER BY s.bucket_start`;
}
