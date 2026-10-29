import { detectThroughputDivergence } from './divergence.detector';
import type { SeriesPoint } from '../signal.types';

const s = (vals: (number | null)[], partialLast = false): SeriesPoint[] =>
  vals.map((v, i) => ({
    bucket: `2026-0${i + 1}-01`,
    value: v,
    partial: partialLast && i === vals.length - 1,
  }));

describe('detectThroughputDivergence', () => {
  it('flags opened at baseline with merged down more than one scale unit', () => {
    const opened = s([20, 20, 20, 20, 20, 20, 20, 20]);
    const merged = s([15, 16, 14, 15, 16, 15, 6, 15]);
    const out = detectThroughputDivergence(opened, merged);
    // merged baseline [15,16,14,15,16,15,15]: median 15, MAD 0, IQR scale 0.37
    // clamped to floor 0.1 * 15 = 1.5; drop 9 >= 2 * 1.5 -> high, score -6.
    // The 14 in bucket 3 is a 0.67-unit drop and is not flagged.
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      detector: 'throughput_divergence',
      metric: 'prs_merged',
      observed: 6,
      score: -6,
      baseline: { median: 15, scale: 1.5, n: 7, scaleSource: 'floor' },
      direction: 'down',
      severity: 'high',
      entity: null,
      examples: [],
      description: 'PRs opened held at 20 while merges fell to 6 in 2026-07-01',
    });
  });

  it('is moderate when the merged drop is at least 1 but under 2 scale units', () => {
    // each 9's merged baseline is {9,10,10,10,11,12}: median 10, MAD 0.5 -> 0.7413,
    // clamped to floor 1; a drop of 1 is exactly 1 scale unit
    const opened = s([20, 20, 20, 20, 20, 20, 20]);
    const merged = s([10, 12, 9, 11, 10, 9, 10]);
    const out = detectThroughputDivergence(opened, merged);
    expect(out.map((x) => [x.bucket, x.severity])).toEqual([
      ['2026-03-01', 'moderate'],
      ['2026-06-01', 'moderate'],
    ]);
  });

  it('does not flag when opened also dropped', () => {
    const opened = s([20, 20, 20, 20, 20, 20, 5, 20]);
    const merged = s([15, 16, 14, 15, 16, 15, 6, 15]);
    expect(detectThroughputDivergence(opened, merged)).toEqual([]);
  });

  it('skips partial and null buckets and needs minBaseline on both series', () => {
    expect(
      detectThroughputDivergence(
        s([20, 20, 20, 20, 20]),
        s([15, 15, 15, 15, 0], true),
      ),
    ).toEqual([]);
    expect(
      detectThroughputDivergence(
        s([20, null, 20, 20, 20]),
        s([15, 15, 15, 15, 0]),
      ),
    ).toEqual([]);
  });
});
