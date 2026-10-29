import {
  DETECTOR_PARAMETERS,
  type DetectorParameters,
  type Baseline,
  type SeriesPoint,
  type Signal,
} from '../signal.types';
import {
  completePoints,
  fmt,
  robustBaseline,
  signalId,
  type CompletePoint,
} from './robust-stats';

const METRIC = 'prs_merged';

/** Count baseline from every complete point except `bucket`, or null when too small. */
function baselineExcluding(
  points: CompletePoint[],
  bucket: string,
  minBaseline: number,
): Baseline | null {
  const others = points.filter((x) => x.bucket !== bucket).map((x) => x.value);
  return others.length < minBaseline ? null : robustBaseline(others, 'count');
}

/** Flags buckets where PRs kept being opened at the usual rate but merges dropped. */
export function detectThroughputDivergence(
  opened: SeriesPoint[],
  merged: SeriesPoint[],
  p: DetectorParameters = DETECTOR_PARAMETERS,
): Signal[] {
  const openedPoints = completePoints(opened);
  const mergedPoints = completePoints(merged);
  const openedByBucket = new Map(openedPoints.map((x) => [x.bucket, x.value]));

  return mergedPoints.flatMap(({ bucket, value: mergedValue }): Signal[] => {
    const openedValue = openedByBucket.get(bucket);
    if (openedValue === undefined) return [];
    const ob = baselineExcluding(openedPoints, bucket, p.minBaseline);
    const mb = baselineExcluding(mergedPoints, bucket, p.minBaseline);
    if (!ob || !mb) return [];

    const openedHeld =
      Math.abs(openedValue - ob.median) <= p.divergenceScaleUnits * ob.scale;
    const drop = mb.median - mergedValue;
    if (!openedHeld || drop < p.divergenceScaleUnits * mb.scale) return [];

    return [
      {
        id: signalId('throughput_divergence', METRIC, bucket),
        detector: 'throughput_divergence',
        metric: METRIC,
        bucket,
        observed: mergedValue,
        baseline: mb,
        score: (mergedValue - mb.median) / mb.scale,
        direction: 'down',
        severity:
          drop >= p.divergenceHighScaleUnits * mb.scale ? 'high' : 'moderate',
        description: `PRs opened held at ${fmt(openedValue)} while merges fell to ${fmt(mergedValue)} in ${bucket}`,
        entity: null,
        examples: [],
      },
    ];
  });
}
