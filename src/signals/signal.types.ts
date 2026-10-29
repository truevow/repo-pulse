import type { FactUnit, MetricName } from './metric-names';

export interface SeriesPoint {
  bucket: string;
  value: number | null;
  partial: boolean;
}

export interface Baseline {
  median: number;
  scale: number;
  n: number;
  scaleSource: 'mad' | 'iqr' | 'floor';
}

export type Detector =
  | 'robust_outlier'
  | 'level_shift'
  | 'review_concentration'
  | 'throughput_divergence';

export type Severity = 'moderate' | 'high';

export interface SignalExample {
  kind: 'pull_request' | 'issue' | 'commit';
  /** `#123` for PRs and issues, short sha for commits. */
  ref: string;
  title: string;
  author: string | null;
  value: number;
  unit: FactUnit;
  url: string;
}

export interface Signal {
  id: string;
  detector: Detector;
  metric: MetricName;
  bucket: string;
  observed: number;
  baseline: Baseline | null;
  score: number;
  direction: 'up' | 'down';
  severity: Severity;
  description: string;
  entity: string | null;
  examples: SignalExample[];
}

export interface ConcentrationRow {
  bucket: string;
  partial: boolean;
  reviews: number;
  top1Share: number | null;
  topLogin: string | null;
}

/** Every detector threshold in one place; echoed in responses as `parameters`. */
export const DETECTOR_PARAMETERS = {
  outlierZ: 3,
  highSeverityZ: 5,
  minBaseline: 4,
  levelShiftRecentBuckets: { week: 2, day: 7 },
  concentrationTop1Share: 0.5,
  concentrationMinReviews: 10,
  concentrationHighShare: 0.75,
  divergenceScaleUnits: 1,
  divergenceHighScaleUnits: 2,
} as const;

export type DetectorParameters = typeof DETECTOR_PARAMETERS;
