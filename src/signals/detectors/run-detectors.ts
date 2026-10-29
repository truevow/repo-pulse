import type { BucketSize } from '../buckets';
import type { MetricName } from '../metric-names';
import {
  DETECTOR_PARAMETERS,
  type ConcentrationRow,
  type SeriesPoint,
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

const SEVERITY_RANK = { high: 0, moderate: 1 } as const;

/** One signal per (metric, bucket): the larger |score| wins, the earlier one on ties. */
function dedup(signals: Signal[]): Signal[] {
  const best = new Map<string, Signal>();
  for (const sig of signals) {
    const key = `${sig.metric}|${sig.bucket}`;
    const current = best.get(key);
    if (!current || Math.abs(sig.score) > Math.abs(current.score)) {
      best.set(key, sig);
    }
  }
  return [...best.values()];
}

export function runDetectors(
  input: DetectorInput,
  p: typeof DETECTOR_PARAMETERS = DETECTOR_PARAMETERS,
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
