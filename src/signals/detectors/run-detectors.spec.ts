import { runDetectors } from './run-detectors';
import { DETECTOR_PARAMETERS, type SeriesPoint } from '../signal.types';

const s = (vals: (number | null)[], partialLast = false): SeriesPoint[] =>
  vals.map((v, i) => ({
    bucket: `2026-0${i + 1}-01`,
    value: v,
    partial: partialLast && i === vals.length - 1,
  }));

describe('runDetectors', () => {
  it('dedups outlier and level shift on the same metric+bucket keeping the larger score', () => {
    const out = runDetectors({
      size: 'week',
      series: { prs_merged: s([10, 11, 9, 10, 12, 10, 25, 26]) },
      concentration: [],
    });
    // level shift at 07-01: 15.5 / floor 1 = 15.5; outlier at 07-01: 15 / 1.4826 = 10.12 (dropped);
    // outlier at 08-01: 16 / 1.4826 = 10.79
    expect(out.map((x) => [x.detector, x.bucket])).toEqual([
      ['level_shift', '2026-07-01'],
      ['robust_outlier', '2026-08-01'],
    ]);
    expect(out[0].score).toBe(15.5);
    expect(out[1].score).toBeCloseTo(16 / 1.4826, 10);
  });

  it('sorts high before moderate', () => {
    const out = runDetectors({
      size: 'week',
      // floor scale 1 -> outlier score 4, moderate
      series: { commits: s([10, 10, 10, 10, 10, 14]) },
      concentration: [
        {
          bucket: '2026-06-01',
          partial: false,
          reviews: 12,
          top1Share: 0.8,
          topLogin: 'alice',
        },
        {
          bucket: '2026-05-01',
          partial: false,
          reviews: 12,
          top1Share: 0.6,
          topLogin: 'bob',
        },
      ],
    });
    expect(out.map((x) => [x.detector, x.severity, x.score])).toEqual([
      ['review_concentration', 'high', 0.8],
      ['robust_outlier', 'moderate', 4],
      ['review_concentration', 'moderate', 0.6],
    ]);
  });

  it('runs divergence when both prs_opened and prs_merged are present', () => {
    const out = runDetectors({
      size: 'week',
      series: {
        prs_opened: s([20, 20, 20, 20, 20, 20, 20, 20]),
        prs_merged: s([15, 16, 14, 15, 16, 15, 6, 15]),
      },
      concentration: [],
    });
    const b7 = out.filter((x) => x.bucket === '2026-07-01');
    // at 07-01: outlier and divergence both score -9 / 1.5 = -6 (high), level shift
    // -4.5 / 1.5 = -3; the tie goes to the more specific detector
    expect(b7).toHaveLength(1);
    expect(b7[0]).toMatchObject({
      detector: 'throughput_divergence',
      metric: 'prs_merged',
      severity: 'high',
      score: -6,
    });
  });

  it('keeps a high divergence over a moderate outlier with the same score', () => {
    const series = {
      prs_opened: s([20, 20, 20, 20, 20, 20, 20, 20]),
      prs_merged: s([15, 16, 14, 15, 16, 15, 9, 15]),
    };
    // merged baseline floor 1.5: outlier z = -6 / 1.5 = -4 (moderate); divergence drop
    // 6 >= 2 * 1.5 (high), same score; level shift -3 / 1.5 = -2 is not flagged
    const out = runDetectors({ size: 'week', series, concentration: [] });
    expect(out.map((x) => [x.detector, x.bucket, x.score, x.severity])).toEqual(
      [['throughput_divergence', '2026-07-01', -4, 'high']],
    );
  });

  it('accepts parameter overrides', () => {
    // floor scale 1 -> score 2.6: below the default 3, above an override of 2.5
    const input = {
      size: 'week' as const,
      series: { commits: s([10, 10, 10, 10, 10, 12.6]) },
      concentration: [],
    };
    expect(runDetectors(input)).toEqual([]);
    const p = { ...DETECTOR_PARAMETERS, outlierZ: 2.5 };
    expect(runDetectors(input, p).map((x) => x.bucket)).toEqual(['2026-06-01']);
  });

  it('returns nothing for empty input', () => {
    expect(
      runDetectors({ size: 'day', series: {}, concentration: [] }),
    ).toEqual([]);
  });
});
