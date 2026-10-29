import { median, robustBaseline } from './robust-stats';

describe('median', () => {
  it('takes the middle value or the mean of the two middle values', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('does not mutate its input', () => {
    const xs = [3, 1, 2];
    median(xs);
    expect(xs).toEqual([3, 1, 2]);
  });

  it('rejects an empty input', () => {
    expect(() => median([])).toThrow();
  });
});

describe('robustBaseline', () => {
  it('uses 1.4826 * MAD when MAD is positive', () => {
    // median 10; |deviations| [0,2,2,1,3,0,1] -> MAD 1
    expect(robustBaseline([10, 8, 12, 9, 13, 10, 11])).toEqual({
      median: 10,
      scale: 1.4826,
      n: 7,
      scaleSource: 'mad',
    });
  });

  it('falls back to IQR / 1.349 when MAD is 0', () => {
    // median 0, MAD 0; q25 = 0, q75 = 10 (linear, position 4.5) -> IQR 10
    const b = robustBaseline([0, 0, 0, 0, 10, 10, 10]);
    expect(b.scaleSource).toBe('iqr');
    expect(b.median).toBe(0);
    expect(b.scale).toBeCloseTo(10 / 1.349, 10);
  });

  it('clamps a near-flat integer baseline to the floor', () => {
    // median 15, MAD 0, IQR 0.5 -> 0.37 < floor max(1, 1.5) = 1.5
    expect(robustBaseline([15, 16, 14, 15, 16, 15, 15])).toEqual({
      median: 15,
      scale: 1.5,
      n: 7,
      scaleSource: 'floor',
    });
    // MAD 0.5 -> 0.7413 < floor 1
    expect(robustBaseline([10, 11, 9, 10, 12, 10])).toMatchObject({
      scale: 1,
      scaleSource: 'floor',
    });
  });

  it('uses a 0.05 floor for ratios', () => {
    // median 0.5, MAD 0.01 -> 0.014826 < floor max(0.05, 0.05)
    const shares = [0.5, 0.52, 0.48, 0.5, 0.51];
    expect(robustBaseline(shares, 'ratio')).toEqual({
      median: 0.5,
      scale: 0.05,
      n: 5,
      scaleSource: 'floor',
    });
    expect(robustBaseline(shares).scale).toBe(1);
  });

  it('falls back to max(1, 0.1 * |median|) on a flat baseline', () => {
    expect(robustBaseline([5, 5, 5, 5])).toEqual({
      median: 5,
      scale: 1,
      n: 4,
      scaleSource: 'floor',
    });
    expect(robustBaseline([-40, -40, -40, -40]).scale).toBe(4);
  });
});
