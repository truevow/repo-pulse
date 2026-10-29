import { detectOutliers } from './outlier.detector';
import { signalId } from './robust-stats';
import type { SeriesPoint } from '../signal.types';

const s = (vals: (number | null)[], partialLast = false): SeriesPoint[] =>
  vals.map((v, i) => ({
    bucket: `2026-0${i + 1}-01`,
    value: v,
    partial: partialLast && i === vals.length - 1,
  }));

describe('detectOutliers', () => {
  it('flags a single spike as high severity', () => {
    // Brief's series [10, 9, 11, 10, 12, 10, 40, 10] gives MAD 0 for the 40's
    // baseline; per controller ruling the series below exercises the MAD path.
    const out = detectOutliers(
      'time_to_first_review_p50_h',
      s([10, 8, 12, 9, 13, 10, 40, 11]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      bucket: '2026-07-01',
      observed: 40,
      direction: 'up',
      severity: 'high',
    });
    expect(out[0].baseline).toMatchObject({ median: 10, scaleSource: 'mad' });
    // (40 - 10) / (1.4826 * 1)
    expect(out[0].score).toBeCloseTo(20.2347, 4);
    expect(out[0]).toMatchObject({
      id: signalId(
        'robust_outlier',
        'time_to_first_review_p50_h',
        '2026-07-01',
      ),
      detector: 'robust_outlier',
      metric: 'time_to_first_review_p50_h',
      baseline: { median: 10, scale: 1.4826, n: 7, scaleSource: 'mad' },
      entity: null,
      examples: [],
      description:
        'time_to_first_review_p50_h was 40 in 2026-07-01, versus a typical 10 (robust z 20.23)',
    });
  });

  it('uses the floor scale on a flat baseline and still flags a large jump', () => {
    const out = detectOutliers('prs_merged', s([10, 10, 10, 10, 10, 30]));
    expect(out).toHaveLength(1);
    expect(out[0].baseline?.scaleSource).toBe('floor');
    expect(out[0].score).toBeCloseTo(20, 5);
  });

  it('does not flag a flat series or trivial wobble', () => {
    expect(detectOutliers('commits', s([5, 5, 5, 5, 5, 5]))).toEqual([]);
    expect(detectOutliers('commits', s([10, 10, 10, 10, 10, 11]))).toEqual([]);
  });

  it('needs at least 4 complete baseline points', () => {
    expect(detectOutliers('commits', s([1, 2, 30, 2]))).toEqual([]);
  });

  it('never scores a partial point and excludes it from baselines', () => {
    expect(
      detectOutliers('prs_opened', s([10, 9, 11, 10, 12, 1], true)),
    ).toEqual([]);
  });

  it('skips null points and flags a drop as down / moderate between 3 and 5', () => {
    // floor scale 1 on the four 10s; 6 -> score -4
    const out = detectOutliers('commits', s([10, null, 10, 10, 10, 6]));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      bucket: '2026-06-01',
      score: -4,
      direction: 'down',
      severity: 'moderate',
      baseline: { median: 10, scale: 1, n: 4, scaleSource: 'floor' },
    });
  });

  it('scores ratio metrics against the 0.05 ratio floor', () => {
    // baseline [0.5,0.52,0.48,0.5,0.51]: MAD 0.01 -> 0.0148 < floor 0.05
    const out = detectOutliers(
      'review_concentration_top1',
      s([0.5, 0.52, 0.48, 0.5, 0.51, 0.9]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      bucket: '2026-06-01',
      severity: 'high',
      baseline: { median: 0.5, scale: 0.05, n: 5, scaleSource: 'floor' },
    });
    expect(out[0].score).toBeCloseTo(8, 10);
  });

  it('does not mutate the input series', () => {
    const series = s([10, 8, 12, 9, 13, 10, 40, 11]);
    const copy = structuredClone(series);
    detectOutliers('commits', series);
    expect(series).toEqual(copy);
  });
});
