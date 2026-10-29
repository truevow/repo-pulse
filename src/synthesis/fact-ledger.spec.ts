import { FactLedger, seedLedgerFromInsights } from './fact-ledger';
import {
  INSIGHTS_FIXTURE,
  LEVEL_SHIFT_SIGNAL,
} from '../../test/fixtures/insights.fixture';

describe('FactLedger', () => {
  it('keys null and undefined bucket/entity the same and lower-cases entities', () => {
    expect(FactLedger.keyOf({ metric: 'm' })).toBe('m||');
    expect(FactLedger.keyOf({ metric: 'm', bucket: null, entity: null })).toBe(
      'm||',
    );
    expect(
      FactLedger.keyOf({ metric: 'reviews', bucket: 'b', entity: 'BoB' }),
    ).toBe('reviews|b|bob');
  });

  it('looks entities up case-insensitively', () => {
    const ledger = new FactLedger();
    ledger.record({ metric: 'reviews', entity: 'Alice' }, 15, 'count');
    expect(ledger.lookup({ metric: 'reviews', entity: 'ALICE' })).toEqual({
      metric: 'reviews',
      bucket: null,
      entity: 'Alice',
      value: 15,
      unit: 'count',
    });
    expect(ledger.lookup({ metric: 'reviews', entity: 'bob' })).toBeUndefined();
  });

  it('overwrites an existing key without growing', () => {
    const ledger = new FactLedger();
    ledger.record({ metric: 'prs_merged', bucket: 'b' }, 1, 'count');
    ledger.record({ metric: 'prs_merged', bucket: 'b' }, 2, 'count');
    expect(ledger.size).toBe(1);
    expect(ledger.lookup({ metric: 'prs_merged', bucket: 'b' })?.value).toBe(2);
  });
});

describe('seedLedgerFromInsights', () => {
  it('seeds bucket metrics, leaderboards and baseline medians from an insights response', () => {
    const ledger = new FactLedger();
    seedLedgerFromInsights(ledger, INSIGHTS_FIXTURE);

    const value = (metric: string, bucket?: string, entity?: string) =>
      ledger.lookup({ metric, bucket, entity });

    // Bucket metrics (non-null only), with units from METRIC_UNITS.
    expect(value('prs_merged', '2026-08-31')).toMatchObject({
      value: 10,
      unit: 'count',
    });
    expect(value('time_to_merge_p50_h', '2026-09-07')).toMatchObject({
      value: 100,
      unit: 'hours',
    });
    expect(value('review_concentration_top1', '2026-09-07')).toMatchObject({
      value: 0.75,
      unit: 'ratio',
    });
    expect(value('commits', '2026-08-31')).toBeUndefined();

    // Leaderboard cells: entity = login, no bucket.
    expect(value('merged_prs', undefined, 'alice')).toMatchObject({
      value: 7,
      unit: 'count',
    });
    expect(value('commits', undefined, 'Alice')?.value).toBe(25);
    expect(value('lines_changed', undefined, 'alice')).toMatchObject({
      value: 1200,
      unit: 'lines',
    });
    expect(value('reviews', undefined, 'bob')?.value).toBe(15);
    expect(value('approvals', undefined, 'bob')?.value).toBe(9);
    expect(value('prs_merged_by', undefined, 'carol')?.value).toBe(11);

    // Signals: baseline medians and example items.
    expect(
      value('time_to_merge_p50_h.baseline_median', '2026-09-07'),
    ).toMatchObject({ value: 20, unit: 'hours' });
    expect(value('prs_merged.baseline_median', '2026-09-07')?.value).toBe(6);
    expect(
      value('review_concentration_top1.baseline_median', '2026-09-07'),
    ).toBeUndefined();
    expect(
      value('time_to_merge_p50_h.item', '2026-09-07', '#123'),
    ).toMatchObject({ value: 100.25, unit: 'hours' });

    // A level shift's observed (recent median) must not overwrite the bucket cell.
    expect(value('prs_merged', '2026-09-07')?.value).toBe(12);
    expect(value('prs_merged.observed', '2026-09-07')).toMatchObject({
      value: 11,
      unit: 'count',
    });

    // 7 bucket cells + 6 leaderboard cells + 2 baselines + 1 example + 1 observed.
    expect(ledger.size).toBe(17);
  });

  it('never seeds facts from a bucket outside the synced range', () => {
    const ledger = new FactLedger();
    seedLedgerFromInsights(ledger, {
      ...INSIGHTS_FIXTURE,
      buckets: INSIGHTS_FIXTURE.buckets.map((b, i) =>
        i === 0 ? { ...b, covered: false } : b,
      ),
      leaderboards: { contributors: [], reviewers: [], mergers: [] },
      signals: [],
    });
    expect(
      ledger.lookup({ metric: 'prs_merged', bucket: '2026-08-31' }),
    ).toBeUndefined();
    expect(
      ledger.lookup({ metric: 'prs_merged', bucket: '2026-09-07' })?.value,
    ).toBe(12);
  });

  it('seeds only the top 10 of each leaderboard, as the prompt shows', () => {
    const ledger = new FactLedger();
    const reviewers = Array.from({ length: 12 }, (_, i) => ({
      login: `user${i}`,
      reviews: 20 - i,
      approvals: 0,
    }));
    seedLedgerFromInsights(ledger, {
      ...INSIGHTS_FIXTURE,
      buckets: [],
      leaderboards: { contributors: [], reviewers, mergers: [] },
      signals: [],
    });
    expect(ledger.lookup({ metric: 'reviews', entity: 'user9' })?.value).toBe(
      11,
    );
    expect(
      ledger.lookup({ metric: 'reviews', entity: 'user10' }),
    ).toBeUndefined();
    // reviews + approvals for 10 reviewers.
    expect(ledger.size).toBe(20);
  });

  it('always records a level shift under .observed, and the cell only when absent or equal', () => {
    const ledger = new FactLedger();
    seedLedgerFromInsights(ledger, {
      ...INSIGHTS_FIXTURE,
      buckets: [],
      leaderboards: { contributors: [], reviewers: [], mergers: [] },
      signals: [{ ...LEVEL_SHIFT_SIGNAL, observed: 12 }],
    });
    const key = { metric: 'prs_merged', bucket: '2026-09-07' };
    expect(ledger.lookup(key)?.value).toBe(12);
    expect(
      ledger.lookup({ metric: 'prs_merged.observed', bucket: '2026-09-07' })
        ?.value,
    ).toBe(12);
    // cell + .observed + .baseline_median
    expect(ledger.size).toBe(3);
  });
});
