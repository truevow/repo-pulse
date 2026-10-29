import type {
  InsightsBucket,
  InsightsResponse,
} from '../../src/signals/insights.types';
import { METRIC_NAMES, type MetricName } from '../../src/signals/metric-names';
import {
  DETECTOR_PARAMETERS,
  type Signal,
} from '../../src/signals/signal.types';

/** Shared by the synthesis unit specs; lives outside `src` so it is never built. */
const metrics = (
  values: Partial<Record<MetricName, number>>,
): InsightsBucket['metrics'] =>
  Object.fromEntries(
    METRIC_NAMES.map((m) => [m, values[m] ?? null]),
  ) as InsightsBucket['metrics'];

export const OUTLIER_SIGNAL: Signal = {
  id: 'robust_outlier:time_to_merge_p50_h:2026-09-07',
  detector: 'robust_outlier',
  metric: 'time_to_merge_p50_h',
  bucket: '2026-09-07',
  observed: 100,
  baseline: { median: 20, scale: 4, n: 6, scaleSource: 'mad' },
  score: 20,
  direction: 'up',
  severity: 'high',
  description: 'time_to_merge_p50_h spiked to 100 against a typical 20',
  entity: null,
  examples: [
    {
      kind: 'pull_request',
      ref: '#123',
      title: 'Big refactor',
      author: 'alice',
      value: 100.25,
      unit: 'hours',
      url: 'https://github.com/acme/widgets/pull/123',
    },
  ],
};

export const CONCENTRATION_SIGNAL: Signal = {
  id: 'review_concentration:review_concentration_top1:2026-09-07',
  detector: 'review_concentration',
  metric: 'review_concentration_top1',
  bucket: '2026-09-07',
  observed: 0.75,
  baseline: null,
  score: 0.75,
  direction: 'up',
  severity: 'moderate',
  description: 'bob gave 75% of reviews',
  entity: 'bob',
  examples: [],
};

/** Level shifts report the recent median, which differs from the bucket cell. */
export const LEVEL_SHIFT_SIGNAL: Signal = {
  id: 'level_shift:prs_merged:2026-09-07',
  detector: 'level_shift',
  metric: 'prs_merged',
  bucket: '2026-09-07',
  observed: 11,
  baseline: { median: 6, scale: 1, n: 5, scaleSource: 'mad' },
  score: 5,
  direction: 'up',
  severity: 'high',
  description:
    'prs_merged moved from a typical 6 to 11 over the last 2 buckets',
  entity: null,
  examples: [],
};

export const INSIGHTS_FIXTURE: InsightsResponse = {
  repository: {
    owner: 'acme',
    name: 'widgets',
    defaultBranch: 'main',
    url: 'https://github.com/acme/widgets',
  },
  window: { from: '2026-08-31T00:00:00.000Z', to: '2026-09-14T00:00:00.000Z' },
  bucket: 'week',
  includeBots: false,
  coverage: {
    from: '2026-08-31T00:00:00.000Z',
    to: '2026-09-14T00:00:00.000Z',
    partial: false,
    lastSyncedAt: '2026-09-14T00:00:00.000Z',
  },
  availability: {
    pullRequests: 'available',
    issues: 'available',
    commits: 'available',
  },
  buckets: [
    {
      key: '2026-08-31',
      start: '2026-08-31T00:00:00.000Z',
      end: '2026-09-07T00:00:00.000Z',
      partial: false,
      covered: true,
      metrics: metrics({
        prs_merged: 10,
        time_to_merge_p50_h: 20,
        review_concentration_top1: 0.4,
      }),
    },
    {
      key: '2026-09-07',
      start: '2026-09-07T00:00:00.000Z',
      end: '2026-09-14T00:00:00.000Z',
      partial: false,
      covered: true,
      metrics: metrics({
        prs_merged: 12,
        time_to_merge_p50_h: 100,
        review_concentration_top1: 0.75,
        commits: 30,
      }),
    },
  ],
  leaderboards: {
    contributors: [
      { login: 'Alice', mergedPrs: 7, commits: 25, linesChanged: 1200 },
    ],
    reviewers: [{ login: 'bob', reviews: 15, approvals: 9 }],
    mergers: [{ login: 'carol', prsMerged: 11 }],
  },
  signals: [OUTLIER_SIGNAL, CONCENTRATION_SIGNAL, LEVEL_SHIFT_SIGNAL],
  parameters: DETECTOR_PARAMETERS,
};
