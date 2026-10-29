import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import { bucketKey, buildBuckets } from '../src/signals/buckets';
import type { MetricsQuery } from '../src/signals/leaderboards.types';
import { METRIC_NAMES } from '../src/signals/metric-names';
import { MetricsRepository } from '../src/signals/metrics.repository';
import { loadSnapshot } from '../src/snapshot/snapshot.service';
import {
  EXPECTED_ALICE_ACTIVITY,
  EXPECTED_BOB_ACTIVITY,
  EXPECTED_LEADERBOARDS,
  EXPECTED_LEADERBOARDS_WITH_BOTS,
  EXPECTED_W4_WITH_BOTS,
  EXPECTED_WEEKS,
  METRICS_FIXTURE,
  METRICS_WINDOW,
  OWNER,
  REPO,
  SPIKE_FIRST_REVIEW_P50,
  SPIKE_W4_SLOWEST_REF,
  SPIKE_WINDOW,
  W1,
  W2,
  W4,
  W4_BOT_SHA,
  W4_DAVE_SHA,
  withLatencySpike,
} from './fixtures/snapshots/metrics-fixture';
import { createTestApp, resetDatabase } from './setup/db';

const day = (key: string) => new Date(`${key}T00:00:00.000Z`);
const prUrl = (n: number) => `https://github.com/${OWNER}/${REPO}/pull/${n}`;

describe('MetricsRepository (DB)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let metrics: MetricsRepository;
  let q: MetricsQuery;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    metrics = new MetricsRepository(prisma);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('base fixture', () => {
    beforeAll(async () => {
      await resetDatabase(prisma);
      const { repositoryId } = await loadSnapshot(prisma, METRICS_FIXTURE);
      q = {
        repositoryId,
        owner: OWNER,
        repo: REPO,
        window: METRICS_WINDOW,
        size: 'week',
        includeBots: false,
      };
    });

    describe('bucketMetrics', () => {
      it('returns every planted number per week, all 15 metrics present', async () => {
        const rows = await metrics.bucketMetrics(q);
        expect(rows).toEqual(EXPECTED_WEEKS);
        for (const row of rows) {
          expect(Object.keys(row).sort()).toEqual(
            ['bucket', 'top_reviewer', ...METRIC_NAMES].sort(),
          );
          for (const m of METRIC_NAMES) {
            expect(['number', 'object']).toContain(typeof row[m]);
          }
        }
      });

      it('includeBots only changes the W4 review metrics', async () => {
        const rows = await metrics.bucketMetrics({ ...q, includeBots: true });
        expect(rows).toEqual([
          ...EXPECTED_WEEKS.slice(0, 3),
          EXPECTED_W4_WITH_BOTS,
        ]);
      });

      it('week keys equal bucketKey of each bucket start', async () => {
        const rows = await metrics.bucketMetrics(q);
        const buckets = buildBuckets(METRICS_WINDOW, 'week');
        expect(rows.map((r) => r.bucket)).toEqual(buckets.map((b) => b.key));
        for (const b of buckets) {
          expect(bucketKey(b.start, 'week')).toBe(b.key);
        }
      });

      it('day buckets: keys match bucketKey and planted days add up', async () => {
        const rows = await metrics.bucketMetrics({ ...q, size: 'day' });
        const buckets = buildBuckets(METRICS_WINDOW, 'day');
        expect(rows).toHaveLength(28);
        expect(rows.map((r) => r.bucket)).toEqual(buckets.map((b) => b.key));
        for (const r of rows)
          expect(bucketKey(day(r.bucket), 'day')).toBe(r.bucket);

        const at = (key: string) => rows.find((r) => r.bucket === key)!;
        expect(at('2026-09-07')).toMatchObject({
          prs_opened: 1,
          time_to_first_review_p50_h: 2,
          commits: 5,
          active_authors: 1,
          bus_factor_50: 1,
          issues_opened: 1,
        });
        expect(at('2026-09-08')).toMatchObject({
          prs_opened: 2,
          time_to_first_review_p50_h: 4,
          reviews_submitted: 1,
        });
        expect(at('2026-09-12').time_to_first_review_p50_h).toBe(100);
        expect(at('2026-09-13')).toMatchObject({
          commits: 0,
          time_to_first_review_p50_h: null,
          bus_factor_50: null,
        });
        const sum = (m: 'commits' | 'reviews_submitted' | 'prs_opened') =>
          rows.reduce((acc, r) => acc + (r[m] ?? 0), 0);
        expect(sum('commits')).toBe(17);
        expect(sum('reviews_submitted')).toBe(8);
        expect(sum('prs_opened')).toBe(8);
      });

      it('returns JS numbers, never bigint or Decimal', async () => {
        const rows = await metrics.bucketMetrics(q);
        for (const row of rows) {
          for (const m of METRIC_NAMES) {
            const v = row[m];
            expect(v === null || typeof v === 'number').toBe(true);
          }
        }
      });
    });

    describe('leaderboards', () => {
      it('ranks contributors, reviewers and mergers without bots', async () => {
        expect(await metrics.leaderboards(q)).toEqual(EXPECTED_LEADERBOARDS);
      });

      it('includes the bot when includeBots is true', async () => {
        expect(await metrics.leaderboards({ ...q, includeBots: true })).toEqual(
          EXPECTED_LEADERBOARDS_WITH_BOTS,
        );
      });
    });

    describe('bucketExamples', () => {
      const ex = (
        metric: Parameters<MetricsRepository['bucketExamples']>[0]['metric'],
        bucket: string,
        extra: { limit?: number; entity?: string; includeBots?: boolean } = {},
      ) =>
        metrics.bucketExamples({
          ...q,
          includeBots: extra.includeBots ?? false,
          metric,
          bucketStart: day(bucket),
          limit: extra.limit ?? 5,
          entity: extra.entity,
        });

      it('time_to_first_review_p50_h: slowest first-reviewed PRs in W1', async () => {
        const rows = await ex('time_to_first_review_p50_h', W1);
        expect(rows.map((r) => r.ref)).toEqual(['#3', '#2', '#1']);
        expect(rows.map((r) => r.value)).toEqual([100, 4, 2]);
        expect(rows[0]).toEqual({
          kind: 'pull_request',
          ref: '#3',
          title: 'PR 3',
          author: 'bob',
          value: 100,
          unit: 'hours',
          url: prUrl(3),
        });
      });

      it('respects limit', async () => {
        const rows = await ex('time_to_first_review_p50_h', W1, { limit: 2 });
        expect(rows.map((r) => r.ref)).toEqual(['#3', '#2']);
      });

      it('time_to_merge_p50_h: slowest merged PRs in W2', async () => {
        const rows = await ex('time_to_merge_p50_h', W2);
        expect(rows.map((r) => [r.ref, r.value, r.unit])).toEqual([
          ['#5', 48, 'hours'],
          ['#4', 24, 'hours'],
        ]);
      });

      it('prs_opened / prs_closed_unmerged: largest PRs by lines', async () => {
        const opened = await ex('prs_opened', W1);
        expect(opened.map((r) => [r.ref, r.value, r.unit])).toEqual([
          ['#3', 300, 'lines'],
          ['#1', 40, 'lines'],
          ['#2', 10, 'lines'],
        ]);
        const closed = await ex('prs_closed_unmerged', W4);
        expect(closed.map((r) => [r.ref, r.value])).toEqual([['#7', 8]]);
        const merged = await ex('prs_merged', W4);
        expect(merged.map((r) => [r.ref, r.value])).toEqual([['#9', 100]]);
      });

      it('reviews_submitted / approvals: PRs with most reviews in bucket', async () => {
        const reviews = await ex('reviews_submitted', W1);
        expect(reviews.map((r) => [r.ref, r.value, r.unit])).toEqual([
          ['#1', 2, 'count'],
          ['#2', 1, 'count'],
          ['#3', 1, 'count'],
        ]);
        const approvals = await ex('approvals', W1);
        expect(approvals.map((r) => [r.ref, r.value])).toEqual([
          ['#1', 1],
          ['#3', 1],
        ]);
      });

      it('review_concentration with entity: PRs that reviewer reviewed', async () => {
        const alice = await ex('review_concentration_top1', W1, {
          entity: 'alice',
        });
        expect(alice.map((r) => [r.ref, r.value, r.unit])).toEqual([
          ['#1', 1, 'count'],
          ['#2', 1, 'count'],
          ['#3', 1, 'count'],
        ]);
        // bob's self-review on #3 is not a review of someone else's PR.
        const bob = await ex('review_concentration_hhi', W1, { entity: 'bob' });
        expect(bob.map((r) => r.ref)).toEqual(['#1']);
        const bot = await ex('review_concentration_top1', W4, {
          entity: 'renovate[bot]',
          includeBots: true,
        });
        expect(bot.map((r) => [r.ref, r.value])).toEqual([
          ['#6', 2],
          ['#7', 1],
        ]);
        const botExcluded = await ex('review_concentration_top1', W4, {
          entity: 'renovate[bot]',
        });
        expect(botExcluded).toEqual([]);
      });

      it('issue examples: longest-open closed, newest opened', async () => {
        const closed = await ex('issue_time_to_close_p50_h', W2);
        expect(closed).toEqual([
          {
            kind: 'issue',
            ref: '#21',
            title: 'Issue 21',
            author: 'carol',
            value: 192,
            unit: 'hours',
            url: `https://github.com/${OWNER}/${REPO}/issues/21`,
          },
          expect.objectContaining({ ref: '#24', value: 12 }),
        ]);
        expect((await ex('issues_closed', W2)).map((r) => r.ref)).toEqual([
          '#21',
          '#24',
        ]);
        // Age at window end (10-05): #22 opened 09-15 = 480h, #24 opened 09-14 = 504h.
        const opened = await ex('issues_opened', W2);
        expect(opened.map((r) => [r.ref, r.value, r.unit])).toEqual([
          ['#22', 480, 'hours'],
          ['#24', 504, 'hours'],
        ]);
      });

      it('commit examples: largest commits by lines (bots included)', async () => {
        const rows = await ex('commits', W4);
        expect(rows).toEqual([
          {
            kind: 'commit',
            ref: W4_BOT_SHA.slice(0, 7),
            title: expect.any(String),
            author: 'renovate[bot]',
            value: 100,
            unit: 'lines',
            url: `https://github.com/${OWNER}/${REPO}/commit/${W4_BOT_SHA}`,
          },
          expect.objectContaining({
            ref: W4_DAVE_SHA.slice(0, 7),
            author: 'dave',
            value: 10,
          }),
        ]);
        expect((await ex('bus_factor_50', W4)).map((r) => r.ref)).toEqual(
          rows.map((r) => r.ref),
        );
      });

      it('empty bucket has no examples', async () => {
        expect(await ex('commits', '2026-09-21')).toEqual([]);
        expect(await ex('time_to_first_review_p50_h', '2026-09-21')).toEqual(
          [],
        );
      });
    });

    describe('contributorActivity', () => {
      it('alice per week, zeros where nothing happened', async () => {
        expect(
          await metrics.contributorActivity({ ...q, login: 'alice' }),
        ).toEqual(EXPECTED_ALICE_ACTIVITY);
      });

      it('bob: self-review is not a review given', async () => {
        expect(
          await metrics.contributorActivity({ ...q, login: 'bob' }),
        ).toEqual(EXPECTED_BOB_ACTIVITY);
      });

      it('unknown login yields one zero row per bucket', async () => {
        const rows = await metrics.contributorActivity({
          ...q,
          login: 'nobody',
        });
        expect(rows).toHaveLength(4);
        for (const r of rows) {
          expect(r).toMatchObject({
            prs_opened: 0,
            prs_merged: 0,
            reviews_given: 0,
            commits: 0,
          });
        }
      });
    });
  });

  describe('latency spike fixture', () => {
    let spike: MetricsQuery;

    beforeAll(async () => {
      await resetDatabase(prisma);
      const { repositoryId } = await loadSnapshot(prisma, withLatencySpike());
      spike = {
        repositoryId,
        owner: OWNER,
        repo: REPO,
        window: SPIKE_WINDOW,
        size: 'week',
        includeBots: false,
      };
    });

    it('plants a W4 first-review spike over six weeks', async () => {
      const rows = await metrics.bucketMetrics(spike);
      expect(rows.map((r) => r.time_to_first_review_p50_h)).toEqual(
        SPIKE_FIRST_REVIEW_P50,
      );
      const examples = await metrics.bucketExamples({
        ...spike,
        metric: 'time_to_first_review_p50_h',
        bucketStart: day(W4),
        limit: 5,
      });
      expect(examples[0].ref).toBe(SPIKE_W4_SLOWEST_REF);
      expect(examples.map((e) => e.value)).toEqual([210, 200, 190, 6, 5]);
    });
  });
});
