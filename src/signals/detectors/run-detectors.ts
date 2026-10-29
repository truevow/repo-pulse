import type { BucketSize } from '../buckets';
import type { MetricName } from '../metric-names';
import {
  DETECTOR_PARAMETERS,
  type DetectorParameters,
  type ConcentrationRow,
  type Detector,
  type SeriesPoint,
  type Severity,
  type Signal,
} from '../signal.types';
import { detectReviewConcentration } from './concentration.detector';
import { detectThroughputDivergence } from './divergence.detector';
import { detectLevelShift } from './level-shift.detector';
import { detectOutliers } from './outlier.detector';

export interface DetectorInput {
  size: BucketSize;
  series: Partial<Record<MetricName, SeriesPoint[]>>;
  concentration: ConcentrationRow[];
}

const SEVERITY_RANK: Record<Severity, number> = { high: 0, moderate: 1 };

/** Lower is more specific; the generic outlier detector loses ties. */
const DETECTOR_RANK: Record<Detector, number> = {
  throughput_divergence: 0,
  review_concentration: 1,
  level_shift: 2,
  robust_outlier: 3,
};

/** True when `a` should replace `b`: larger |score|, then higher severity, then more specific detector. */
function beats(a: Signal, b: Signal): boolean {
  return (
    (Math.abs(a.score) - Math.abs(b.score) ||
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      DETECTOR_RANK[b.detector] - DETECTOR_RANK[a.detector]) > 0
  );
}

/** One signal per (metric, bucket), chosen by `beats`. */
function dedup(signals: Signal[]): Signal[] {
  const best = new Map<string, Signal>();
  for (const sig of signals) {
    const key = `${sig.metric}|${sig.bucket}`;
    const current = best.get(key);
    if (!current || beats(sig, current)) best.set(key, sig);
  }
  return [...best.values()];
}

export function runDetectors(
  input: DetectorInput,
  p: DetectorParameters = DETECTOR_PARAMETERS,
): Signal[] {
  const entries = (
    Object.entries(input.series) as [MetricName, SeriesPoint[] | undefined][]
  ).filter((e): e is [MetricName, SeriesPoint[]] => e[1] !== undefined);
  const { prs_opened: opened, prs_merged: merged } = input.series;

  const all = [
    ...entries.flatMap(([metric, series]) => detectOutliers(metric, series, p)),
    ...entries.flatMap(([metric, series]) =>
      detectLevelShift(metric, series, input.size, p),
    ),
    ...detectReviewConcentration(input.concentration, p),
    ...(opened && merged ? detectThroughputDivergence(opened, merged, p) : []),
  ];

  return dedup(all).sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      Math.abs(b.score) - Math.abs(a.score),
  );
}
