import type { BucketSize } from '../buckets';
import { METRIC_UNITS, type MetricName } from '../metric-names';
import {
  DETECTOR_PARAMETERS,
  type DetectorParameters,
  type SeriesPoint,
  type Signal,
} from '../signal.types';
import {
  completePoints,
  fmt,
  median,
  robustBaseline,
  signalId,
  zSeverity,
} from './robust-stats';

/** Compares the median of the last k complete buckets with the earlier ones. */
export function detectLevelShift(
  metric: MetricName,
  series: SeriesPoint[],
  size: BucketSize,
  p: DetectorParameters = DETECTOR_PARAMETERS,
): Signal[] {
  const k = p.levelShiftRecentBuckets[size];
  const points = completePoints(series);
  const before = points.slice(0, -k).map((x) => x.value);
  const recent = points.slice(-k);
  if (recent.length !== k || before.length < p.minBaseline) return [];

  const baseline = robustBaseline(before, METRIC_UNITS[metric]);
  const recentMedian = median(recent.map((x) => x.value));
  const score = (recentMedian - baseline.median) / baseline.scale;
  if (Math.abs(score) < p.outlierZ) return [];

  const bucket = recent[0].bucket;
  return [
    {
      id: signalId('level_shift', metric, bucket),
      detector: 'level_shift',
      metric,
      bucket,
      observed: recentMedian,
      baseline,
      score,
      direction: score > 0 ? 'up' : 'down',
      severity: zSeverity(score, p),
      description: `${metric} moved from a typical ${fmt(baseline.median)} to ${fmt(recentMedian)} over the last ${k} buckets`,
      entity: null,
      examples: [],
    },
  ];
}
