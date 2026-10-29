import { FactLedger, seedLedgerFromInsights } from './fact-ledger';
import { extractNumbers, groundOutput } from './grounding';
import type { Evidence, Hypothesis, SynthesisOutput } from './output.schema';
import {
  CONCENTRATION_SIGNAL,
  INSIGHTS_FIXTURE,
  OUTLIER_SIGNAL,
} from '../../test/fixtures/insights.fixture';

const SIGNALS = INSIGHTS_FIXTURE.signals;

const ev = (over: Partial<Evidence>): Evidence => ({
  signal_id: null,
  metric: 'prs_merged',
  bucket: '2026-09-07',
  entity: null,
  value: 12,
  note: 'n',
  ...over,
});

const hyp = (
  evidence: Evidence[],
  over: Partial<Hypothesis> = {},
): Hypothesis => ({
  statement: 's',
  confidence: 0.7,
  evidence,
  alternative_explanations: [],
  suggested_check: 'c',
  ...over,
});

const out = (
  hypotheses: Hypothesis[],
  headline = 'h',
  narrative = 'n',
): SynthesisOutput => ({ headline, narrative, hypotheses, data_caveats: [] });

const seeded = (): FactLedger => {
  const ledger = new FactLedger();
  seedLedgerFromInsights(ledger, INSIGHTS_FIXTURE);
  return ledger;
};

describe('groundOutput', () => {
  it('accepts evidence matching a ledger cell within tolerance', () => {
    const output = out([hyp([ev({ value: 12.4 })])]);
    const r = groundOutput(output, seeded(), SIGNALS);
    expect(r.status).toBe('ok');
    expect(r.rejected).toEqual([]);
    expect(r.droppedHypotheses).toBe(0);
    expect(r.output.hypotheses[0].evidence).toEqual([ev({ value: 12.4 })]);
  });

  it('rejects count evidence just outside 0.5', () => {
    const r = groundOutput(
      out([hyp([ev({ value: 12.6 })])]),
      seeded(),
      SIGNALS,
    );
    expect(r.rejected).toEqual([
      {
        hypothesisIndex: 0,
        evidence: ev({ value: 12.6 }),
        reason: 'value_mismatch',
        expected: 12,
      },
    ]);
  });

  it('accepts count evidence at exactly 0.5 away and rejects 0.51', () => {
    const ok = groundOutput(
      out([hyp([ev({ value: 12.5 })])]),
      seeded(),
      SIGNALS,
    );
    expect(ok.status).toBe('ok');
    const bad = groundOutput(
      out([hyp([ev({ value: 12.51 })])]),
      seeded(),
      SIGNALS,
    );
    expect(bad.rejected).toEqual([
      {
        hypothesisIndex: 0,
        evidence: ev({ value: 12.51 }),
        reason: 'value_mismatch',
        expected: 12,
      },
    ]);
  });

  it('rejects ratio evidence outside 0.01', () => {
    const bad = ev({
      signal_id: CONCENTRATION_SIGNAL.id,
      metric: 'review_concentration_top1',
      value: 0.8,
    });
    const r = groundOutput(out([hyp([bad])]), seeded(), SIGNALS);
    expect(r.rejected).toEqual([
      {
        hypothesisIndex: 0,
        evidence: bad,
        reason: 'value_mismatch',
        expected: 0.75,
      },
    ]);
    expect(r.status).toBe('failed');
  });

  it('accepts ratio evidence exactly 0.01 away despite float error', () => {
    const r = groundOutput(
      out([hyp([ev({ metric: 'review_concentration_top1', value: 0.76 })])]),
      seeded(),
      SIGNALS,
    );
    expect(r.status).toBe('ok');
  });

  it('matches leaderboard entities case-insensitively', () => {
    const r = groundOutput(
      out([
        hyp([
          ev({ metric: 'reviews', bucket: null, entity: 'BOB', value: 15 }),
        ]),
      ]),
      seeded(),
      SIGNALS,
    );
    expect(r.status).toBe('ok');
  });

  it('rejects unknown signal ids and unknown facts, drops a hypothesis with no surviving evidence, status failed', () => {
    const unknownSignal = ev({ signal_id: 'nope' });
    const unknownFact = ev({ metric: 'prs_merged', bucket: '2025-01-01' });
    const output = out([hyp([unknownSignal]), hyp([unknownFact])]);
    const r = groundOutput(output, seeded(), SIGNALS);
    expect(r.status).toBe('failed');
    expect(r.droppedHypotheses).toBe(2);
    expect(r.output.hypotheses).toEqual([]);
    expect(r.rejected).toEqual([
      { hypothesisIndex: 0, evidence: unknownSignal, reason: 'unknown_signal' },
      { hypothesisIndex: 1, evidence: unknownFact, reason: 'unknown_fact' },
    ]);
  });

  it('status partial when some evidence rejected but hypothesis survives', () => {
    const good1 = ev({
      signal_id: OUTLIER_SIGNAL.id,
      metric: 'time_to_merge_p50_h',
      value: 100,
    });
    const bad = ev({ value: 20 });
    const good2 = ev({
      signal_id: OUTLIER_SIGNAL.id,
      metric: 'time_to_merge_p50_h.item',
      entity: '#123',
      value: 100.25,
    });
    const dropped = hyp([ev({ signal_id: 'ghost' })]);
    const output = out([hyp([good1, bad, good2]), dropped]);
    const snapshot = structuredClone(output);

    const r = groundOutput(output, seeded(), SIGNALS);

    expect(r.status).toBe('partial');
    expect(r.droppedHypotheses).toBe(1);
    expect(r.output.hypotheses).toHaveLength(1);
    expect(r.output.hypotheses[0].evidence).toEqual([good1, good2]);
    expect(r.rejected).toEqual([
      {
        hypothesisIndex: 0,
        evidence: bad,
        reason: 'value_mismatch',
        expected: 12,
      },
      {
        hypothesisIndex: 1,
        evidence: dropped.evidence[0],
        reason: 'unknown_signal',
      },
    ]);
    // The model output is never mutated.
    expect(output).toEqual(snapshot);
  });

  it('status ok with no hypotheses at all', () => {
    expect(groundOutput(out([]), seeded(), SIGNALS).status).toBe('ok');
  });

  it('lists narrative numerals that match no evidence value, treating 75% as 0.75 and ignoring #123 and dates', () => {
    const output = out(
      [
        hyp([
          ev({
            signal_id: CONCENTRATION_SIGNAL.id,
            metric: 'review_concentration_top1',
            entity: null,
            value: 0.75,
          }),
          ev({
            signal_id: OUTLIER_SIGNAL.id,
            metric: 'time_to_merge_p50_h.item',
            entity: '#123',
            value: 100.25,
          }),
        ]),
      ],
      'Reviews concentrated: 75% on one reviewer',
      'PR #123 took 100.3 hours (about 100) in 2026-W37 starting 2026-09-07; ' +
        'merges fell by 40 and 7 people left; 40 again.',
    );
    const r = groundOutput(output, seeded(), SIGNALS);
    expect(r.unverifiedNumbers).toEqual([40, 7]);
  });

  it('checks prose numerals against the ledger fact, not the drifted evidence value', () => {
    // Evidence 12.4 is accepted for fact 12, but prose "12.9" is 0.9 from the fact.
    const output = out(
      [hyp([ev({ value: 12.4 })])],
      'h',
      'Merges hit 12.4, or 12.9 by another count',
    );
    expect(groundOutput(output, seeded(), SIGNALS).unverifiedNumbers).toEqual([
      12.9,
    ]);
  });

  it('reports a percentage once, as written, when neither form matches', () => {
    const output = out(
      [hyp([ev({ metric: 'review_concentration_top1', value: 0.75 })])],
      'h',
      'Bob did 60% of reviews',
    );
    expect(groundOutput(output, seeded(), SIGNALS).unverifiedNumbers).toEqual([
      60,
    ]);
  });
});

describe('extractNumbers', () => {
  it('handles PR refs, dates, percentages, thousands separators and decimals', () => {
    expect(
      extractNumbers(
        'PR #123 merged on 2026-09-07 after 4.5 days; 75% of 1,200 reviews in 2026-W40.',
      ),
    ).toEqual([4.5, 75, 0.75, 1200]);
  });

  it('skips ordinals and digits inside identifiers but keeps negatives and years', () => {
    expect(
      extractNumbers('1st week: time_to_merge_p50_h fell -3 in 2026, 12 vs 8'),
    ).toEqual([-3, 2026, 12, 8]);
  });

  it('reads leading-dot decimals and digits after an ellipsis', () => {
    expect(extractNumbers('a .85 ratio')).toEqual([0.85]);
    expect(extractNumbers('fell...40 PRs')).toEqual([40]);
  });

  it('skips ISO timestamps', () => {
    expect(extractNumbers('synced 2026-09-07T10:00:00Z, 5 left')).toEqual([5]);
  });
});
