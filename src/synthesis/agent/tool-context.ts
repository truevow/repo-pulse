import type { InsightsResponse } from '../../signals/insights.types';
import type { MetricsQuery } from '../../signals/leaderboards.types';
import type { MetricsRepository } from '../../signals/metrics.repository';
import type { FactLedger } from '../fact-ledger';

export type ToolName =
  | 'get_metric_series'
  | 'get_bucket_examples'
  | 'get_contributor_activity'
  | 'compare_windows';

/** Everything the read-only agent tools need; tools never write to the database. */
export interface ToolContext {
  repositoryId: number;
  owner: string;
  repo: string;
  insights: InsightsResponse;
  query: MetricsQuery;
  ledger: FactLedger;
  metrics: MetricsRepository;
}
