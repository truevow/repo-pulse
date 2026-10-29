import type { Signal } from '../src/signals/signal.types';
import type { CalibratedHypothesis } from '../src/synthesis/calibration';
import type { NarrativeResponse } from '../src/synthesis/narrative.types';
import type { EvalExpectation } from './cases';

/**
 * Deterministic grading of one narrative run. No model is involved: every
 * check is a pure function of the response, the case's expectation and the
 * detector signals of the same window.
 */

export const CHECKS = [
  'schema_and_grounding',
  'names_planted_metric',
  'confidence_ordering',
  'unverified_numbers',
] as const;
export type CheckName = (typeof CHECKS)[number];

/** `pass: null` means the check does not apply to this case. */
export interface CheckResult {
  pass: boolean | null;
  reason: string;
}

export type CheckResults = Record<CheckName, CheckResult>;

/** Prose numbers that matched no evidence; more than this fails the (report-only) check. */
export const MAX_UNVERIFIED_NUMBERS = 2;
/** Highest confidence a control case may report. */
export const CONTROL_MAX_CONFIDENCE = 0.4;

/** What grading needs from a detector signal. */
export type SignalRef = Pick<Signal, 'id' | 'entity'>;

const isPlanted = (e: EvalExpectation): boolean => !e.control;

/** Highest calibrated confidence; the first one wins ties. */
export function topHypothesis(
  hypotheses: CalibratedHypothesis[],
): CalibratedHypothesis | undefined {
  return hypotheses.reduce<CalibratedHypothesis | undefined>(
    (best, h) =>
      best === undefined || h.confidence > best.confidence ? h : best,
    undefined,
  );
}

export const topConfidence = (r: NarrativeResponse): number =>
  topHypothesis(r.hypotheses)?.confidence ?? 0;

/**
 * `time_to_first_review_p50_h.observed`, `.item`, `.baseline_median` and the
 * compare_windows suffixes all name the same underlying metric.
 */
const baseMetric = (metric: string): string => metric.split('.')[0];

type EvidenceItem = CalibratedHypothesis['evidence'][number];

/** The item cites the expected metric (any of a list), in the expected bucket when set. */
function citesMetric(e: EvidenceItem, expect: EvalExpectation): boolean {
  if (expect.metric !== undefined) {
    const wanted: string[] = Array.isArray(expect.metric)
      ? expect.metric
      : [expect.metric];
    if (!wanted.includes(baseMetric(e.metric))) return false;
  }
  return expect.bucket === undefined || e.bucket === expect.bucket;
}

/** Logins an item names: its own entity and the entity of the signal it cites. */
function entitiesOf(
  e: EvidenceItem,
  signalsById: ReadonlyMap<string, SignalRef>,
): string[] {
  const signal = e.signal_id ? signalsById.get(e.signal_id) : undefined;
  return [e.entity, signal?.entity].flatMap((x) =>
    x ? [x.toLowerCase()] : [],
  );
}

/**
 * Whether a hypothesis names the planted cause: one evidence item cites the
 * expected metric (and bucket), and, when an entity is expected, the
 * hypothesis names it on that item, on the signal that item cites, or on
 * another of its evidence items. The entity cannot be required on the metric
 * item itself: by the grounding contract a bucket metric or signal fact
 * carries entity = null (a key with an entity is rejected as unknown), so a
 * reviewer is named through a per-person fact such as reviews_given.
 */
export function namesPlantedCause(
  h: CalibratedHypothesis,
  expect: EvalExpectation,
  signalsById: ReadonlyMap<string, SignalRef>,
): boolean {
  const hits = h.evidence.filter((e) => citesMetric(e, expect));
  if (hits.length === 0) return false;
  if (expect.entity === undefined) return true;
  const want = expect.entity.toLowerCase();
  return h.evidence.some((e) => entitiesOf(e, signalsById).includes(want));
}

function describeExpect(e: EvalExpectation): string {
  const metric = Array.isArray(e.metric) ? e.metric.join('|') : e.metric;
  return [
    `metric ${metric}`,
    e.bucket && `bucket ${e.bucket}`,
    e.entity && `entity ${e.entity}`,
  ]
    .filter(Boolean)
    .join(', ');
}

export function gradeRun(
  r: NarrativeResponse,
  expect: EvalExpectation,
  signals: readonly SignalRef[],
  /** Mean top confidence of the control case; null when control was not run. */
  controlMean: number | null,
): CheckResults {
  const rejected = r.grounding.rejected.length;
  const schema_and_grounding: CheckResult =
    rejected === 0
      ? { pass: true, reason: 'schema valid, no evidence rejected' }
      : {
          pass: false,
          reason: `${rejected} evidence item(s) rejected: ${r.grounding.rejected
            .map(
              (x) =>
                `${x.evidence.metric}@${x.evidence.bucket ?? '-'} ${x.reason}`,
            )
            .join('; ')}`,
        };

  // names_planted_metric: the expected entity is matched across the top
  // hypothesis (the matching item, the signal it cites, or another evidence
  // item), because ledger facts for signal metrics carry entity = null by design.
  const top = topHypothesis(r.hypotheses);
  let names_planted_metric: CheckResult;
  if (!isPlanted(expect)) {
    names_planted_metric = { pass: null, reason: 'control case' };
  } else if (!top) {
    names_planted_metric = { pass: false, reason: 'no hypotheses' };
  } else {
    const byId = new Map(signals.map((s) => [s.id, s]));
    const hit = namesPlantedCause(top, expect, byId);
    names_planted_metric = hit
      ? { pass: true, reason: `top hypothesis cites ${describeExpect(expect)}` }
      : {
          pass: false,
          reason: `top hypothesis cites none of ${describeExpect(expect)} (cites ${top.evidence
            .map((e) => `${e.metric}@${e.bucket ?? '-'}/${e.entity ?? '-'}`)
            .join(', ')})`,
        };
  }

  let confidence_ordering: CheckResult;
  const max = topConfidence(r);
  if (!isPlanted(expect)) {
    confidence_ordering =
      r.hypotheses.length === 0
        ? { pass: true, reason: 'no hypotheses' }
        : {
            pass: max <= CONTROL_MAX_CONFIDENCE,
            reason: `max confidence ${max} (limit ${CONTROL_MAX_CONFIDENCE})`,
          };
  } else if (controlMean === null) {
    confidence_ordering = { pass: null, reason: 'control case not run' };
  } else {
    confidence_ordering = {
      pass: max > controlMean,
      reason: `top confidence ${max} vs control mean ${round2(controlMean)}`,
    };
  }

  const unverified = r.grounding.unverifiedNumbers.length;
  const unverified_numbers: CheckResult = {
    pass: unverified <= MAX_UNVERIFIED_NUMBERS,
    reason:
      unverified === 0
        ? 'none'
        : `${unverified}: ${r.grounding.unverifiedNumbers.join(', ')}`,
  };

  return {
    schema_and_grounding,
    names_planted_metric,
    confidence_ordering,
    unverified_numbers,
  };
}

/** A run that raised (502/503 or anything else) fails every applicable check. */
export function failedRun(
  expect: EvalExpectation,
  problem: string,
  controlMean: number | null,
): CheckResults {
  const fail: CheckResult = { pass: false, reason: `run failed: ${problem}` };
  return {
    schema_and_grounding: fail,
    names_planted_metric: isPlanted(expect)
      ? fail
      : { pass: null, reason: 'control case' },
    confidence_ordering:
      isPlanted(expect) && controlMean === null
        ? { pass: null, reason: 'control case not run' }
        : fail,
    unverified_numbers: fail,
  };
}

export const round2 = (x: number): number => Math.round(x * 100) / 100;
