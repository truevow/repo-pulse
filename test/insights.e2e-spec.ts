import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import type { InsightsResponse } from '../src/signals/insights.types';
import { METRIC_NAMES, type MetricName } from '../src/signals/metric-names';
import { DETECTOR_PARAMETERS } from '../src/signals/signal.types';
import { loadSnapshot } from '../src/snapshot/snapshot.service';
import {
  EXPECTED_LEADERBOARDS,
  EXPECTED_W4_WITH_BOTS,
  EXPECTED_WEEKS,
  METRICS_FIXTURE,
  OWNER,
  REPO,
  SPIKE_FIRST_REVIEW_P50,
  SPIKE_W4_SLOWEST_REF,
  W1,
  W2,
  W3,
  W4,
  withLatencySpike,
} from './fixtures/snapshots/metrics-fixture';
import {
  PR_DISABLED_COMMITS,
  PR_DISABLED_OWNER,
  PR_DISABLED_REPO,
  prDisabledFixture,
} from './fixtures/snapshots/pr-disabled-fixture';
import { createTestApp, resetDatabase } from './setup/db';

const PROBLEM = 'https://repo-pulse.local/problems/';
const iso = (date: string) => `${date}T00:00:00.000Z`;

const PR_METRICS: MetricName[] = [
  'prs_opened',
  'prs_merged',
  'prs_closed_unmerged',
  'time_to_first_review_p50_h',
  'time_to_merge_p50_h',
  'reviews_submitted',
  'approvals',
  'review_concentration_top1',
  'review_concentration_hhi',
];
const ISSUE_METRICS: MetricName[] = [
  'issues_opened',
  'issues_closed',
  'issue_time_to_close_p50_h',
];

/** EXPECTED_WEEKS rows reshaped as response `metrics` (no bucket / top_reviewer). */
function metricsOf(
  row: (typeof EXPECTED_WEEKS)[number],
): Record<MetricName, number | null> {
  return Object.fromEntries(METRIC_NAMES.map((m) => [m, row[m]])) as Record<
    MetricName,
    number | null
  >;
}

describe('Insights (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const get = (path: string, query: Record<string, string> = {}) =>
    request(app.getHttpServer())
      .get(`/api/v1/repos/${path}/insights`)
      .query(query);
  const insights = async (
    query: Record<string, string>,
    owner = OWNER,
    repo = REPO,
  ): Promise<InsightsResponse> =>
    (await get(`${owner}/${repo}`, query).expect(200)).body as InsightsResponse;

  const expectProblem = async (
    res: request.Response,
    status: number,
    type: string,
  ) => {
    expect(res.status).toBe(status);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({ status, type: PROBLEM + type });
  };

  const expectEveryMetricKey = (body: InsightsResponse) => {
    for (const b of body.buckets) {
      expect(Object.keys(b.metrics).sort()).toEqual([...METRIC_NAMES].sort());
    }
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('base fixture', () => {
    const covered = { from: W1, to: '2026-10-05' };

    beforeAll(async () => {
      await resetDatabase(prisma);
      await loadSnapshot(prisma, METRICS_FIXTURE);
    });

    it('returns the planted weekly numbers, leaderboards and parameters', async () => {
      const body = await insights(covered);

      expect(body.repository).toEqual({
        owner: OWNER,
        name: REPO,
        defaultBranch: 'main',
        url: `https://github.com/${OWNER}/${REPO}`,
      });
      expect(body.window).toEqual({ from: iso(W1), to: iso('2026-10-05') });
      expect(body.bucket).toBe('week');
      expect(body.includeBots).toBe(false);
      expect(body.coverage).toEqual({
        from: iso(W1),
        to: iso('2026-10-05'),
        partial: false,
        lastSyncedAt: iso('2026-10-05'),
      });
      expect(body.availability).toEqual({
        pullRequests: 'available',
        issues: 'available',
        commits: 'available',
      });
      expect(body.buckets.map((b) => b.key)).toEqual([W1, W2, W3, W4]);
      expect(body.buckets[0]).toMatchObject({
        start: iso(W1),
        end: iso(W2),
        partial: false,
      });
      expect(body.buckets.map((b) => b.metrics)).toEqual(
        EXPECTED_WEEKS.map(metricsOf),
      );
      expectEveryMetricKey(body);
      expect(body.leaderboards).toEqual(EXPECTED_LEADERBOARDS);
      expect(body.parameters.outlierZ).toBe(3);
      expect(body.parameters).toEqual(DETECTOR_PARAMETERS);
      expect(Array.isArray(body.signals)).toBe(true);
      for (const s of body.signals) {
        expect(s.examples.length).toBeLessThanOrEqual(5);
      }
    });

    it('includeBots=true changes only the W4 review metrics', async () => {
      const body = await insights({ ...covered, includeBots: 'true' });
      expect(body.includeBots).toBe(true);
      expect(body.buckets[3].metrics).toEqual(metricsOf(EXPECTED_W4_WITH_BOTS));
      expect(body.buckets.slice(0, 3).map((b) => b.metrics)).toEqual(
        EXPECTED_WEEKS.slice(0, 3).map(metricsOf),
      );
    });

    it('flags a window wider than coverage as partial without starting a sync', async () => {
      const body = await insights({ from: '2026-08-10', to: '2026-10-05' });
      expect(body.coverage).toEqual({
        from: iso(W1),
        to: iso('2026-10-05'),
        partial: true,
        lastSyncedAt: iso('2026-10-05'),
      });
      expect(body.buckets).toHaveLength(8);
      expectEveryMetricKey(body);
      // Buckets before coverage hold no data and must not drive detectors.
      const uncovered = body.buckets.slice(0, 4).map((b) => b.key);
      expect(body.signals.filter((s) => uncovered.includes(s.bucket))).toEqual(
        [],
      );
      const coveredOnly = await insights(covered);
      expect(body.signals).toEqual(coveredOnly.signals);
      expect(await prisma.syncJob.count()).toBe(0);
    });

    it('looks the repository up case-insensitively and echoes stored casing', async () => {
      const body = await insights(covered, 'ACME', 'Metrics');
      expect(body.repository.owner).toBe(OWNER);
      expect(body.repository.name).toBe(REPO);
      expect(body.repository.url).toBe(`https://github.com/${OWNER}/${REPO}`);
      expect(body.buckets.map((b) => b.metrics)).toEqual(
        EXPECTED_WEEKS.map(metricsOf),
      );
    });

    it('supports day buckets', async () => {
      const body = await insights({ from: W1, to: W2, bucket: 'day' });
      expect(body.bucket).toBe('day');
      expect(body.buckets.map((b) => b.key)).toEqual([
        '2026-09-07',
        '2026-09-08',
        '2026-09-09',
        '2026-09-10',
        '2026-09-11',
        '2026-09-12',
        '2026-09-13',
      ]);
      expectEveryMetricKey(body);
      const total = (m: MetricName) =>
        body.buckets.reduce((sum, b) => sum + (b.metrics[m] ?? 0), 0);
      expect(total('commits')).toBe(EXPECTED_WEEKS[0].commits);
      expect(total('prs_opened')).toBe(EXPECTED_WEEKS[0].prs_opened);
    });
  });

  describe('PR- and issue-disabled repository', () => {
    beforeAll(async () => {
      await resetDatabase(prisma);
      await loadSnapshot(prisma, prDisabledFixture());
    });

    it('nulls PR, review and issue metrics and raises no signals on them', async () => {
      const body = await insights(
        { from: W1, to: '2026-10-05' },
        PR_DISABLED_OWNER,
        PR_DISABLED_REPO,
      );
      expect(body.availability).toEqual({
        pullRequests: 'unavailable',
        issues: 'unavailable',
        commits: 'available',
      });
      expect(body.repository.defaultBranch).toBe('trunk');
      expectEveryMetricKey(body);
      for (const b of body.buckets) {
        for (const m of [...PR_METRICS, ...ISSUE_METRICS]) {
          expect(b.metrics[m]).toBeNull();
        }
        expect(b.metrics.commits).toBe(PR_DISABLED_COMMITS[b.key]);
      }
      const unavailable = new Set<string>([...PR_METRICS, ...ISSUE_METRICS]);
      expect(body.signals.filter((s) => unavailable.has(s.metric))).toEqual([]);
      expect(body.leaderboards.reviewers).toEqual([]);
      expect(body.leaderboards.mergers).toEqual([]);
      expect(body.leaderboards.contributors.map((c) => c.login).sort()).toEqual(
        ['alice', 'bob'],
      );
    });
  });

  describe('planted latency spike', () => {
    beforeAll(async () => {
      await resetDatabase(prisma);
      await loadSnapshot(prisma, withLatencySpike());
    });

    it('raises one first-review signal in W4 with the slowest PR first', async () => {
      const body = await insights({ from: W1, to: '2026-10-19' });
      expect(body.coverage.partial).toBe(false);
      expect(
        body.buckets.map((b) => b.metrics.time_to_first_review_p50_h),
      ).toEqual(SPIKE_FIRST_REVIEW_P50);

      const latency = body.signals.filter(
        (s) => s.metric === 'time_to_first_review_p50_h',
      );
      expect(latency).toHaveLength(1);
      expect(latency[0].bucket).toBe(W4);
      expect(latency[0].examples[0].ref).toBe(SPIKE_W4_SLOWEST_REF);
      expect(latency[0].examples.length).toBeLessThanOrEqual(5);
      for (const s of body.signals) {
        expect(s.examples.length).toBeLessThanOrEqual(5);
      }
    });
  });

  describe('errors', () => {
    beforeAll(async () => {
      await resetDatabase(prisma);
      await loadSnapshot(prisma, METRICS_FIXTURE);
    });

    it('404 repo-not-synced for an unknown repository', async () => {
      const res = await get('acme/unknown', { from: W1, to: W3 });
      await expectProblem(res, 404, 'repo-not-synced');
      expect(res.body.detail).toBe(
        'POST /api/v1/repos/acme/unknown/sync first',
      );
    });

    it.each([
      ['bucket=month', `${OWNER}/${REPO}`, { bucket: 'month' }],
      ['owner=../x', `${encodeURIComponent('../x')}/${REPO}`, {}],
      ['from after to', `${OWNER}/${REPO}`, { from: W4, to: W1 }],
      [
        'a 30-week window',
        `${OWNER}/${REPO}`,
        { from: '2026-03-30', to: '2026-10-26' },
      ],
      ['a malformed date', `${OWNER}/${REPO}`, { from: '2026-9-7' }],
      ['an impossible date', `${OWNER}/${REPO}`, { from: '2026-02-30' }],
      ['includeBots=yes', `${OWNER}/${REPO}`, { includeBots: 'yes' }],
    ])('400 validation-error for %s', async (_name, path, query) => {
      const res = await get(path, query);
      await expectProblem(res, 400, 'validation-error');
    });
  });
});
