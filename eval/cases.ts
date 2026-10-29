import type { MetricName } from '../src/signals/metric-names';
import type { Perturbation, SyntheticSpec } from './fixtures/synthetic';

/** Bucket metrics plus the per-person activity metric from get_contributor_activity. */
export type ExpectedMetric = MetricName | 'reviews_given';

export interface EvalExpectation {
  /** The top hypothesis must cite one of these metrics (a single name or any of a list). */
  metric?: ExpectedMetric | ExpectedMetric[];
  /** ...in this bucket, when set. */
  bucket?: string;
  /** ...for this entity (case-insensitive), when set. */
  entity?: string;
  /** Nothing is planted: confidence must stay low. */
  control?: boolean;
}

export interface EvalCase {
  name: string;
  spec: SyntheticSpec;
  expect: EvalExpectation;
}

export const START = '2026-08-31';
export const WEEKS = 8;

/** Repo names are neutral so they never hint at the planted cause. */
function spec(seed: number, perturbations: Perturbation[]): SyntheticSpec {
  return {
    owner: 'evalco',
    name: `service-${seed}`,
    start: START,
    weeks: WEEKS,
    prsPerWeek: 25,
    authors: ['alice', 'bob', 'carol', 'dave'],
    reviewers: ['alice', 'bob', 'carol'],
    baseFirstReviewHours: 6,
    baseMergeHours: 30,
    seed,
    perturbations,
  };
}

/** Ordered: control runs first so planted cases can compare against it. */
export const CASES: EvalCase[] = [
  {
    name: 'control',
    spec: spec(5, []),
    expect: { control: true },
  },
  {
    name: 'latency_spike',
    spec: spec(1, [{ type: 'latency_spike', week: 6, factor: 5 }]),
    expect: { metric: 'time_to_first_review_p50_h', bucket: '2026-10-05' },
  },
  {
    name: 'reviewer_dropout',
    spec: spec(2, [{ type: 'reviewer_dropout', week: 6, login: 'bob' }]),
    expect: {
      metric: [
        'reviews_submitted',
        'review_concentration_top1',
        'time_to_first_review_p50_h',
        'reviews_given',
      ],
      entity: 'bob',
    },
  },
  {
    name: 'throughput_shift',
    spec: spec(3, [{ type: 'throughput_shift', fromWeek: 5, factor: 0.4 }]),
    expect: { metric: 'prs_merged' },
  },
  {
    name: 'concentration',
    spec: spec(4, [
      { type: 'concentration', week: 5, login: 'alice', share: 0.8 },
    ]),
    expect: {
      metric: 'review_concentration_top1',
      entity: 'alice',
      bucket: '2026-09-28',
    },
  },
  {
    // Expected to answer with a caveat and no pull-request hypotheses.
    name: 'commit_only',
    spec: spec(6, [{ type: 'disable_prs' }]),
    expect: { control: true },
  },
];
