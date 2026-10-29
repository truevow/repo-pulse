import { detectLevelShift } from './level-shift.detector';
import type { SeriesPoint } from '../signal.types';

const s = (vals: (number | null)[], partialLast = false): SeriesPoint[] =>
  vals.map((v, i) => ({
    bucket: `2026-0${i + 1}-01`,
    value: v,
    partial: partialLast && i === vals.length - 1,
  }));

describe('detectLevelShift', () => {
  it('flags a sustained shift at the first recent bucket', () => {
    const out = detectLevelShift(
      'prs_merged',
      s([10, 11, 9, 10, 12, 10, 25, 26]),
      'week',
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      bucket: '2026-07-01',
      direction: 'up',
      severity: 'high',
    });
    // baseline [10,11,9,10,12,10]: median 10, MAD 0.5 -> 0.7413 < floor 1; recent median 25.5
    expect(out[0]).toMatchObject({
      detector: 'level_shift',
      metric: 'prs_merged',
      observed: 25.5,
      score: 15.5,
      baseline: { median: 10, scale: 1, n: 6, scaleSource: 'floor' },
      entity: null,
      examples: [],
      description:
        'prs_merged moved from a typical 10 to 25.5 over the last 2 buckets',
    });
  });

  it('does not flag recent buckets that match the baseline', () => {
    // recent median 10.5 vs baseline median 10, floor scale 1 -> score 0.5
    expect(
      detectLevelShift(
        'prs_merged',
        s([10, 11, 9, 10, 12, 10, 10, 11]),
        'week',
      ),
    ).toEqual([]);
  });

  it('uses 7 recent buckets for daily series', () => {
    const vals = [5, 6, 4, 5, 6, 0, 0, 0, 0, 0, 0, 0];
    const series = vals.map((v, i) => ({
      bucket: `2026-10-${String(i + 1).padStart(2, '0')}`,
      value: v,
      partial: false,
    }));
    const out = detectLevelShift('commits', series, 'day');
    // baseline [5,6,4,5,6]: median 5, MAD 1 -> scale 1.4826; recent median 0
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      bucket: '2026-10-06',
      observed: 0,
      direction: 'down',
      severity: 'moderate',
      description:
        'commits moved from a typical 5 to 0 over the last 7 buckets',
    });
    expect(out[0].score).toBeCloseTo(-5 / 1.4826, 10);
  });

  it('needs minBaseline complete points before the recent window', () => {
    expect(
      detectLevelShift('prs_merged', s([10, 10, 10, 30, 30]), 'week'),
    ).toEqual([]);
  });

  it('ignores partial and null points', () => {
    // complete non-null: [10,10,10,10,30,30]; partial trailing 0 is dropped
    const out = detectLevelShift(
      'prs_merged',
      s([10, 10, null, 10, 10, 30, 30, 0], true),
      'week',
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      bucket: '2026-06-01',
      observed: 30,
      score: 20,
      baseline: { median: 10, scale: 1, n: 4, scaleSource: 'floor' },
    });
  });
});
