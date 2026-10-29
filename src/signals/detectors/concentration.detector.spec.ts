import type { ConcentrationRow } from '../signal.types';
import { detectReviewConcentration } from './concentration.detector';

const row = (over: Partial<ConcentrationRow>): ConcentrationRow => ({
  bucket: '2026-10-05',
  partial: false,
  reviews: 12,
  top1Share: 0.8,
  topLogin: 'alice',
  ...over,
});

describe('detectReviewConcentration', () => {
  it('flags top1 share over 0.5 with at least 10 reviews, names the reviewer, high at 0.75', () => {
    const out = detectReviewConcentration([
      row({
        bucket: '2026-10-05',
        reviews: 12,
        top1Share: 0.8,
        topLogin: 'alice',
      }),
      row({
        bucket: '2026-10-12',
        reviews: 8,
        top1Share: 0.6,
        topLogin: 'bob',
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      detector: 'review_concentration',
      metric: 'review_concentration_top1',
      bucket: '2026-10-05',
      observed: 0.8,
      score: 0.8,
      baseline: null,
      direction: 'up',
      severity: 'high',
      entity: 'alice',
      examples: [],
      description: 'alice submitted 80% of 12 reviews in 2026-10-05',
    });
  });

  it('is moderate below 0.75 and inclusive at the 0.5 / 10 thresholds', () => {
    const out = detectReviewConcentration([
      row({
        bucket: '2026-10-05',
        reviews: 10,
        top1Share: 0.5,
        topLogin: 'carol',
      }),
      row({
        bucket: '2026-10-12',
        reviews: 20,
        top1Share: 0.49,
        topLogin: 'dan',
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      bucket: '2026-10-05',
      severity: 'moderate',
      entity: 'carol',
      description: 'carol submitted 50% of 10 reviews in 2026-10-05',
    });
  });

  it('skips partial buckets and buckets without a top reviewer', () => {
    expect(
      detectReviewConcentration([
        row({ partial: true, top1Share: 0.9 }),
        row({ reviews: 0, top1Share: null, topLogin: null }),
      ]),
    ).toEqual([]);
  });
});
