import { calibrate, type CalibrationContext } from './calibration';
import type { Evidence, Hypothesis } from './output.schema';
import type { Signal } from '../signals/signal.types';

const signal = (id: string, severity: Signal['severity']): Signal => ({
  id,
  detector: 'robust_outlier',
  metric: 'prs_merged',
  bucket: '2026-09-07',
  observed: 1,
  baseline: null,
  score: 4,
  direction: 'up',
  severity,
  description: 'd',
  entity: null,
  examples: [],
});

const signalsById = new Map(
  [
    signal('high', 'high'),
    signal('mod1', 'moderate'),
    signal('mod2', 'moderate'),
  ].map((s) => [s.id, s]),
);

const ctx = (over: Partial<CalibrationContext> = {}): CalibrationContext => ({
  signalsById,
  coveragePartial: false,
  anyUnavailable: false,
  rejectedCount: 0,
  ...over,
});

const ev = (signal_id: string | null): Evidence => ({
  signal_id,
  metric: 'prs_merged',
  bucket: '2026-09-07',
  entity: null,
  value: 1,
  note: 'n',
});

const hyp = (confidence: number, evidence: Evidence[]): Hypothesis => ({
  statement: 's',
  confidence,
  evidence,
  alternative_explanations: ['a'],
  suggested_check: 'c',
});

describe('calibrate', () => {
  it('caps at 0.4 with one evidence item', () => {
    const h = hyp(0.9, [ev('high')]);
    const c = calibrate(h, ctx());
    expect(c).toEqual({
      ...h,
      model_confidence: 0.9,
      confidence: 0.4,
      adjustments: ['few_evidence_items'],
    });
  });

  it('lists only the first cap when a later cap is already above the value', () => {
    // few_evidence_items → 0.4; no_signal_cited's 0.5 cap changes nothing.
    const c = calibrate(hyp(0.9, [ev(null)]), ctx());
    expect(c.confidence).toBe(0.4);
    expect(c.adjustments).toEqual(['few_evidence_items']);
  });

  it('leaves a low confidence alone when every cap is above it', () => {
    const c = calibrate(hyp(0.3, [ev(null)]), ctx({ coveragePartial: true }));
    expect(c.confidence).toBe(0.3);
    expect(c.model_confidence).toBe(0.3);
    expect(c.adjustments).toEqual([]);
  });

  it('caps at 0.5 when no signal cited, 0.6 when only moderate signals cited', () => {
    const none = calibrate(hyp(0.8, [ev(null), ev(null)]), ctx());
    expect(none.confidence).toBe(0.5);
    expect(none.adjustments).toEqual(['no_signal_cited']);

    const moderate = calibrate(hyp(0.8, [ev('mod1'), ev('mod2')]), ctx());
    expect(moderate.confidence).toBe(0.6);
    expect(moderate.adjustments).toEqual(['moderate_signal_only']);

    // Signal ids that resolve to nothing count as no signal cited.
    const ghosts = calibrate(hyp(0.8, [ev('ghost1'), ev('ghost2')]), ctx());
    expect(ghosts.confidence).toBe(0.5);
    expect(ghosts.adjustments).toEqual(['no_signal_cited']);

    const mixed = calibrate(hyp(0.8, [ev('mod1'), ev('high')]), ctx());
    expect(mixed.confidence).toBe(0.8);
    expect(mixed.adjustments).toEqual([]);
  });

  it('multiplies by 0.8 after a rejection and rounds to 2 decimals', () => {
    const c = calibrate(
      hyp(0.9, [ev('high'), ev(null)]),
      ctx({ rejectedCount: 2 }),
    );
    expect(c.confidence).toBe(0.72);
    expect(c.adjustments).toEqual(['evidence_rejected']);
  });

  it('multiplies by 0.8 after a rejection and caps at 0.5 on partial coverage; records adjustments in order', () => {
    const c = calibrate(
      hyp(0.9, [ev('high'), ev('high')]),
      ctx({ rejectedCount: 1, coveragePartial: true }),
    );
    expect(c.model_confidence).toBe(0.9);
    expect(c.confidence).toBe(0.5);
    expect(c.adjustments).toEqual(['evidence_rejected', 'partial_data']);
  });

  it('applies partial_data when a source is unavailable and chains every rule', () => {
    const c = calibrate(
      hyp(0.95, [ev('mod1'), ev(null)]),
      ctx({ rejectedCount: 1, anyUnavailable: true }),
    );
    // 0.95 → cap 0.6 (moderate only) → ×0.8 = 0.48 → partial cap 0.5 is above.
    expect(c.confidence).toBe(0.48);
    expect(c.adjustments).toEqual([
      'moderate_signal_only',
      'evidence_rejected',
    ]);
  });

  it('does not mutate the input hypothesis', () => {
    const h = hyp(0.9, [ev('high')]);
    const snapshot = structuredClone(h);
    calibrate(h, ctx());
    expect(h).toEqual(snapshot);
  });
});
