import type { FactLedger } from './fact-ledger';
import type { Evidence, Hypothesis, SynthesisOutput } from './output.schema';
import type { FactUnit } from '../signals/metric-names';
import type { Signal } from '../signals/signal.types';

export const TOLERANCE: Record<FactUnit, number> = {
  count: 0.5,
  hours: 0.5,
  lines: 0.5,
  ratio: 0.01,
};

/** Absorbs float error, e.g. |0.76 − 0.75| = 0.010000000000000009. */
const EPSILON = 1e-9;

export type RejectReason = 'unknown_signal' | 'unknown_fact' | 'value_mismatch';

export interface GroundingResult {
  output: SynthesisOutput;
  status: 'ok' | 'partial' | 'failed';
  rejected: Array<{
    hypothesisIndex: number;
    evidence: Evidence;
    reason: RejectReason;
    expected?: number;
  }>;
  unverifiedNumbers: number[];
  droppedHypotheses: number;
}

/**
 * Keeps only evidence that names a known signal (if any) and cites a value
 * present in the ledger within the unit's tolerance; drops hypotheses left
 * with no evidence. Returns new objects; `output` is not mutated.
 */
export function groundOutput(
  output: SynthesisOutput,
  ledger: FactLedger,
  signals: Signal[],
): GroundingResult {
  const signalIds = new Set(signals.map((s) => s.id));
  const rejected: GroundingResult['rejected'] = [];
  const verified: Array<{ value: number; unit: FactUnit }> = [];
  const hypotheses: Hypothesis[] = [];

  output.hypotheses.forEach((h, hypothesisIndex) => {
    const kept: Evidence[] = [];
    for (const evidence of h.evidence) {
      if (evidence.signal_id !== null && !signalIds.has(evidence.signal_id)) {
        rejected.push({ hypothesisIndex, evidence, reason: 'unknown_signal' });
        continue;
      }
      const fact = ledger.lookup(evidence);
      if (fact === undefined) {
        rejected.push({ hypothesisIndex, evidence, reason: 'unknown_fact' });
        continue;
      }
      if (
        Math.abs(evidence.value - fact.value) >
        TOLERANCE[fact.unit] + EPSILON
      ) {
        rejected.push({
          hypothesisIndex,
          evidence,
          reason: 'value_mismatch',
          expected: fact.value,
        });
        continue;
      }
      kept.push({ ...evidence });
      // Prose is checked against the fact itself, so drift never stacks.
      verified.push({ value: fact.value, unit: fact.unit });
    }
    if (kept.length > 0) {
      hypotheses.push({
        ...h,
        evidence: kept,
        alternative_explanations: [...h.alternative_explanations],
      });
    }
  });

  const droppedHypotheses = output.hypotheses.length - hypotheses.length;
  const status: GroundingResult['status'] =
    output.hypotheses.length > 0 && hypotheses.length === 0
      ? 'failed'
      : rejected.length === 0 && droppedHypotheses === 0
        ? 'ok'
        : 'partial';

  const unverified: number[] = [];
  for (const token of extractNumberTokens(
    `${output.headline} ${output.narrative}`,
  )) {
    const ok = token.some((n) =>
      verified.some((f) => verifies(n, f.value, f.unit)),
    );
    if (!ok && !unverified.includes(token[0])) unverified.push(token[0]);
  }

  return {
    output: {
      ...output,
      hypotheses,
      data_caveats: [...output.data_caveats],
    },
    status,
    rejected,
    unverifiedNumbers: unverified,
    droppedHypotheses,
  };
}

const near = (a: number, b: number, tol: number): boolean =>
  Math.abs(a - b) <= tol + EPSILON;
const round = (v: number, decimals: number): number =>
  Math.round(v * 10 ** decimals) / 10 ** decimals;

/** Whether a numeral in prose plausibly restates evidence value `v`. */
function verifies(n: number, v: number, unit: FactUnit): boolean {
  if (unit === 'ratio') {
    // Ratios are written as 0.75, 0.8 or 75 (from "75%" or bare).
    return (
      near(n, v, 0.005) || near(n, round(v, 1), 0) || near(n, v * 100, 0.5)
    );
  }
  return near(n, v, 0.5) || near(n, round(v, 0), 0) || near(n, round(v, 1), 0);
}

// Dates, ISO timestamps and ISO week labels are not quantities.
const DATE_LIKE =
  /\d{4}-(?:W\d{2}|\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?)/g;
// Not preceded by a word char or `#` (PR refs); thousands groups, plain digits
// or a leading-dot decimal (`.85`, but not the last dot of an ellipsis).
const NUMERAL =
  /(?<![\w#])-?(?:(?:\d{1,3}(?:,\d{3})+(?!\d)|\d+)(?:\.\d+)?|(?<![.\d])\.\d+)%?/g;
const ORDINAL_SUFFIX = /^(?:st|nd|rd|th)\b/i;

/**
 * Numerals in `text`, one entry per written token: `[n]`, or `[n, n/100]`
 * for `n%`.
 */
export function extractNumberTokens(text: string): number[][] {
  const masked = text.replace(DATE_LIKE, (m) => ' '.repeat(m.length));
  const tokens: number[][] = [];
  for (const match of masked.matchAll(NUMERAL)) {
    const raw = match[0];
    const end = match.index + raw.length;
    if (ORDINAL_SUFFIX.test(masked.slice(end))) continue;
    const percent = raw.endsWith('%');
    const n = Number((percent ? raw.slice(0, -1) : raw).replace(/,/g, ''));
    tokens.push(percent ? [n, n / 100] : [n]);
  }
  return tokens;
}

/** Decimal numerals in `text`; `n%` yields `n` and `n/100`. */
export function extractNumbers(text: string): number[] {
  return extractNumberTokens(text).flat();
}
