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
  robustBaseline,
  signalId,
  zSeverity,
} from './robust-stats';

/** Scores each complete point against all other complete points of the series. */
export function detectOutliers(
  metric: MetricName,
  series: SeriesPoint[],
  p: DetectorParameters = DETECTOR_PARAMETERS,
): Signal[] {
  const unit = METRIC_UNITS[metric];
  const points = completePoints(series);
  const signals: Signal[] = [];
  points.forEach((point, i) => {
    const others = points.filter((_, j) => j !== i).map((o) => o.value);
    if (others.length < p.minBaseline) return;
    const baseline = robustBaseline(others, unit);
    const score = (point.value - baseline.median) / baseline.scale;
    if (Math.abs(score) < p.outlierZ) return;
    signals.push({
      id: signalId('robust_outlier', metric, point.bucket),
      detector: 'robust_outlier',
      metric,
      bucket: point.bucket,
      observed: point.value,
      baseline,
      score,
      direction: score > 0 ? 'up' : 'down',
      severity: zSeverity(score, p),
      description: `${metric} was ${fmt(point.value)} in ${point.bucket}, versus a typical ${fmt(baseline.median)} (robust z ${fmt(score)})`,
      entity: null,
      examples: [],
    });
  });
  return signals;
}
