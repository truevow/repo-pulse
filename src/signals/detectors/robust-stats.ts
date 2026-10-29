import { createHash } from 'node:crypto';
import type { FactUnit, MetricName } from '../metric-names';
import type {
  Baseline,
  Detector,
  DetectorParameters,
  SeriesPoint,
  Severity,
} from '../signal.types';

const MAD_TO_SIGMA = 1.4826;
const IQR_TO_SIGMA = 1.349;

function sorted(xs: readonly number[]): number[] {
  if (xs.length === 0) throw new Error('empty input');
  return [...xs].sort((a, b) => a - b);
}

/** Linear-interpolated quantile (type 7) over an ascending array. */
function quantileSorted(asc: readonly number[], q: number): number {
  const pos = (asc.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return asc[lo] + (asc[hi] - asc[lo]) * (pos - lo);
}

export function median(xs: number[]): number {
  return quantileSorted(sorted(xs), 0.5);
}

/** Smallest scale a baseline may have: max(1, 0.1·|median|), or max(0.05, 0.1·|median|) for ratios. */
function scaleFloor(m: number, unit: FactUnit): number {
  return Math.max(unit === 'ratio' ? 0.05 : 1, 0.1 * Math.abs(m));
}

/**
 * Median and a robust scale: 1.4826·MAD, else IQR/1.349, clamped from below by
 * the unit's floor so near-flat baselines do not turn trivial wobble into signals.
 */
export function robustBaseline(
  xs: number[],
  unit: FactUnit = 'count',
): Baseline {
  const asc = sorted(xs);
  const m = quantileSorted(asc, 0.5);
  const n = asc.length;
  const floor = scaleFloor(m, unit);
  const mad = median(asc.map((x) => Math.abs(x - m)));
  const iqr = quantileSorted(asc, 0.75) - quantileSorted(asc, 0.25);
  const [candidate, source]: [number, Baseline['scaleSource']] =
    mad > 0 ? [MAD_TO_SIGMA * mad, 'mad'] : [iqr / IQR_TO_SIGMA, 'iqr'];
  return candidate >= floor
    ? { median: m, scale: candidate, n, scaleSource: source }
    : { median: m, scale: floor, n, scaleSource: 'floor' };
}

// Shared detector helpers.

export interface CompletePoint {
  bucket: string;
  value: number;
}

/** Points that may be scored or used as baseline: not partial, value present. */
export function completePoints(
  series: readonly SeriesPoint[],
): CompletePoint[] {
  return series.flatMap((p) =>
    !p.partial && p.value !== null
      ? [{ bucket: p.bucket, value: p.value }]
      : [],
  );
}

export function zSeverity(score: number, p: DetectorParameters): Severity {
  return Math.abs(score) > p.highSeverityZ ? 'high' : 'moderate';
}

/** Up to 2 decimals, trailing zeros trimmed. */
export function fmt(x: number): string {
  return String(Number(x.toFixed(2)));
}

export function signalId(
  detector: Detector,
  metric: MetricName,
  bucket: string,
): string {
  return createHash('sha1')
    .update(`${detector}|${metric}|${bucket}`)
    .digest('hex')
    .slice(0, 12);
}
