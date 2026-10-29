import type { CalibratedHypothesis } from '../src/synthesis/calibration';
import type { NarrativeResponse } from '../src/synthesis/narrative.types';
import {
  failedRun,
  gradeRun,
  namesPlantedCause,
  topHypothesis,
} from './checks';

type Item = CalibratedHypothesis['evidence'][number];

const item = (over: Partial<Item>): Item => ({
  signal_id: null,
  metric: 'time_to_first_review_p50_h',
  bucket: '2026-10-05',
  entity: null,
  value: 1,
  note: '',
  ...over,
});

const hyp = (confidence: number, evidence: Item[]): CalibratedHypothesis => ({
  statement: 's',
  confidence,
  model_confidence: confidence,
  adjustments: [],
  evidence,
  alternative_explanations: [],
  suggested_check: 'c',
});

const response = (
  hypotheses: CalibratedHypothesis[],
  over: Partial<NarrativeResponse['grounding']> = {},
): NarrativeResponse =>
  ({
    hypotheses,
    grounding: {
      status: 'ok',
      rejected: [],
      unverifiedNumbers: [],
      droppedHypotheses: 0,
      ...over,
    },
  }) as unknown as NarrativeResponse;

const none = new Map<string, { id: string; entity: string | null }>();

describe('eval checks', () => {
  it('takes the highest-confidence hypothesis as the top one', () => {
    const a = hyp(0.5, [item({})]);
    const b = hyp(0.7, [item({})]);
    expect(topHypothesis([a, b])).toBe(b);
    expect(topHypothesis([])).toBeUndefined();
  });

  it('matches the metric with or without a fact suffix, and the bucket', () => {
    const want = {
      metric: 'time_to_first_review_p50_h' as const,
      bucket: '2026-10-05',
    };
    expect(namesPlantedCause(hyp(1, [item({})]), want, none)).toBe(true);
    expect(
      namesPlantedCause(
        hyp(1, [
          item({ metric: 'time_to_first_review_p50_h.item', entity: '#12' }),
        ]),
        want,
        none,
      ),
    ).toBe(true);
    expect(
      namesPlantedCause(hyp(1, [item({ bucket: '2026-10-12' })]), want, none),
    ).toBe(false);
    expect(
      namesPlantedCause(hyp(1, [item({ metric: 'prs_merged' })]), want, none),
    ).toBe(false);
  });

  it('accepts any of a list of metrics', () => {
    const want = { metric: ['reviews_submitted', 'reviews_given'] as const };
    expect(
      namesPlantedCause(
        hyp(1, [item({ metric: 'reviews_given', entity: 'bob' })]),
        { metric: [...want.metric], entity: 'BOB' },
        none,
      ),
    ).toBe(true);
  });

  it('finds the entity on the cited signal or on another item, case-insensitively', () => {
    const want = {
      metric: 'review_concentration_top1' as const,
      bucket: '2026-09-28',
      entity: 'alice',
    };
    const metricItem = item({
      metric: 'review_concentration_top1',
      bucket: '2026-09-28',
      signal_id: 'sig1',
    });
    expect(namesPlantedCause(hyp(1, [metricItem]), want, none)).toBe(false);
    expect(
      namesPlantedCause(
        hyp(1, [metricItem]),
        want,
        new Map([['sig1', { id: 'sig1', entity: 'alice' }]]),
      ),
    ).toBe(true);
    expect(
      namesPlantedCause(
        hyp(1, [
          metricItem,
          item({
            metric: 'reviews_given',
            bucket: '2026-09-28',
            entity: 'Alice',
          }),
        ]),
        want,
        none,
      ),
    ).toBe(true);
  });

  it('grades control confidence against the ceiling and planted against the control mean', () => {
    const control = { control: true };
    expect(
      gradeRun(response([]), control, [], null).confidence_ordering.pass,
    ).toBe(true);
    expect(
      gradeRun(response([hyp(0.4, [item({})])]), control, [], null)
        .confidence_ordering.pass,
    ).toBe(true);
    expect(
      gradeRun(response([hyp(0.45, [item({})])]), control, [], null)
        .confidence_ordering.pass,
    ).toBe(false);
    expect(
      gradeRun(response([]), control, [], null).names_planted_metric.pass,
    ).toBeNull();

    const planted = { metric: 'time_to_first_review_p50_h' as const };
    const r = response([hyp(0.6, [item({})])]);
    expect(gradeRun(r, planted, [], 0.3).confidence_ordering.pass).toBe(true);
    expect(gradeRun(r, planted, [], 0.6).confidence_ordering.pass).toBe(false);
    expect(gradeRun(r, planted, [], null).confidence_ordering.pass).toBeNull();
  });

  it('fails grounding on any rejected item and counts unverified numbers', () => {
    const r = response([hyp(0.6, [item({})])], {
      rejected: [
        { hypothesisIndex: 0, evidence: item({}), reason: 'unknown_fact' },
      ],
      unverifiedNumbers: [1, 2, 3],
    });
    const checks = gradeRun(r, { metric: 'prs_merged' }, [], 0);
    expect(checks.schema_and_grounding.pass).toBe(false);
    expect(checks.unverified_numbers.pass).toBe(false);
    expect(checks.names_planted_metric.pass).toBe(false);
  });

  it('fails every applicable check for a run that raised', () => {
    const checks = failedRun({ control: true }, '502 synthesis-failed', 0);
    expect(checks.schema_and_grounding.pass).toBe(false);
    expect(checks.confidence_ordering.pass).toBe(false);
    expect(checks.names_planted_metric.pass).toBeNull();
  });
});
