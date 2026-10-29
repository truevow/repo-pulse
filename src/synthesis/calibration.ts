import type { Hypothesis } from './output.schema';
import type { Signal } from '../signals/signal.types';

export interface CalibrationContext {
  signalsById: Map<string, Signal>;
  coveragePartial: boolean;
  anyUnavailable: boolean;
  /** Evidence items rejected by grounding for this hypothesis. */
  rejectedCount: number;
}

export interface CalibratedHypothesis extends Hypothesis {
  model_confidence: number;
  confidence: number;
  adjustments: string[];
}

interface Rule {
  name: string;
  applies: (h: Hypothesis, ctx: CalibrationContext) => boolean;
  adjust: (c: number) => number;
}

const cap = (limit: number) => (c: number) => Math.min(c, limit);

function citedSignals(h: Hypothesis, ctx: CalibrationContext): Signal[] {
  return h.evidence.flatMap((e) => {
    const s =
      e.signal_id === null ? undefined : ctx.signalsById.get(e.signal_id);
    return s ? [s] : [];
  });
}

/** Applied in this order; each is listed in `adjustments` only if it changed the value. */
const RULES: Rule[] = [
  {
    name: 'few_evidence_items',
    applies: (h) => h.evidence.length < 2,
    adjust: cap(0.4),
  },
  {
    name: 'no_signal_cited',
    // No cited id resolves to a known signal.
    applies: (h, ctx) => citedSignals(h, ctx).length === 0,
    adjust: cap(0.5),
  },
  {
    name: 'moderate_signal_only',
    applies: (h, ctx) => {
      const cited = citedSignals(h, ctx);
      return cited.length > 0 && cited.every((s) => s.severity === 'moderate');
    },
    adjust: cap(0.6),
  },
  {
    name: 'evidence_rejected',
    applies: (_h, ctx) => ctx.rejectedCount > 0,
    adjust: (c) => c * 0.8,
  },
  {
    name: 'partial_data',
    applies: (_h, ctx) => ctx.coveragePartial || ctx.anyUnavailable,
    adjust: cap(0.5),
  },
];

/** Bounds the model's self-reported confidence by what its evidence supports. */
export function calibrate(
  h: Hypothesis,
  ctx: CalibrationContext,
): CalibratedHypothesis {
  let c = h.confidence;
  const adjustments: string[] = [];
  for (const rule of RULES) {
    if (!rule.applies(h, ctx)) continue;
    const next = rule.adjust(c);
    if (next !== c) {
      adjustments.push(rule.name);
      c = next;
    }
  }
  return {
    ...h,
    evidence: h.evidence.map((e) => ({ ...e })),
    alternative_explanations: [...h.alternative_explanations],
    model_confidence: h.confidence,
    confidence: Math.round(c * 100) / 100,
    adjustments,
  };
}
