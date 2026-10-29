import type { InsightsResponse } from '../signals/insights.types';
import {
  METRIC_NAMES,
  METRIC_UNITS,
  type FactUnit,
} from '../signals/metric-names';

export interface FactKey {
  metric: string;
  bucket?: string | null;
  entity?: string | null;
}

export interface Fact extends FactKey {
  value: number;
  unit: FactUnit;
}

/** Every number the model was shown, addressable by (metric, bucket, entity). */
export class FactLedger {
  private readonly facts = new Map<string, Fact>();

  /** Entities are lower-cased: the model may change login casing. */
  static keyOf(k: FactKey): string {
    return `${k.metric}|${k.bucket ?? ''}|${(k.entity ?? '').toLowerCase()}`;
  }

  /** Later records win: tool results overwrite seeded cells. */
  record(key: FactKey, value: number, unit: FactUnit): void {
    this.facts.set(FactLedger.keyOf(key), {
      metric: key.metric,
      bucket: key.bucket ?? null,
      entity: key.entity ?? null,
      value,
      unit,
    });
  }

  lookup(key: FactKey): Fact | undefined {
    const fact = this.facts.get(FactLedger.keyOf(key));
    return fact && { ...fact };
  }

  get size(): number {
    return this.facts.size;
  }
}

export function seedLedgerFromInsights(
  ledger: FactLedger,
  insights: InsightsResponse,
): void {
  for (const b of insights.buckets) {
    for (const m of METRIC_NAMES) {
      const v = b.metrics[m];
      if (v !== null)
        ledger.record({ metric: m, bucket: b.key }, v, METRIC_UNITS[m]);
    }
  }

  const { contributors, reviewers, mergers } = insights.leaderboards;
  for (const c of contributors) {
    ledger.record(
      { metric: 'merged_prs', entity: c.login },
      c.mergedPrs,
      'count',
    );
    ledger.record({ metric: 'commits', entity: c.login }, c.commits, 'count');
    ledger.record(
      { metric: 'lines_changed', entity: c.login },
      c.linesChanged,
      'lines',
    );
  }
  for (const r of reviewers) {
    ledger.record({ metric: 'reviews', entity: r.login }, r.reviews, 'count');
    ledger.record(
      { metric: 'approvals', entity: r.login },
      r.approvals,
      'count',
    );
  }
  for (const m of mergers) {
    ledger.record(
      { metric: 'prs_merged_by', entity: m.login },
      m.prsMerged,
      'count',
    );
  }

  for (const s of insights.signals) {
    const unit = METRIC_UNITS[s.metric];
    const cell = { metric: s.metric, bucket: s.bucket };
    // Usually the bucket cell itself; a level shift reports the recent median
    // instead, which must not overwrite the real bucket value.
    const existing = ledger.lookup(cell);
    if (existing === undefined || existing.value === s.observed) {
      ledger.record(cell, s.observed, unit);
    } else {
      ledger.record(
        { metric: `${s.metric}.observed`, bucket: s.bucket },
        s.observed,
        unit,
      );
    }
    if (s.baseline !== null) {
      ledger.record(
        { metric: `${s.metric}.baseline_median`, bucket: s.bucket },
        s.baseline.median,
        unit,
      );
    }
    for (const ex of s.examples) {
      ledger.record(
        { metric: `${s.metric}.item`, bucket: s.bucket, entity: ex.ref },
        ex.value,
        ex.unit,
      );
    }
  }
}
