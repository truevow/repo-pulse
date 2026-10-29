import type { BucketSize } from './buckets';
import type { Leaderboards } from './leaderboards.types';
import type { MetricName } from './metric-names';
import type { DETECTOR_PARAMETERS, Signal } from './signal.types';

export type Availability = 'available' | 'unavailable';

export interface InsightsBucket {
  key: string;
  start: string;
  end: string;
  partial: boolean;
  metrics: Record<MetricName, number | null>;
}

export interface InsightsResponse {
  repository: {
    owner: string;
    name: string;
    defaultBranch: string;
    url: string;
  };
  window: { from: string; to: string };
  bucket: BucketSize;
  includeBots: boolean;
  coverage: {
    from: string | null;
    to: string | null;
    partial: boolean;
    lastSyncedAt: string | null;
  };
  availability: {
    pullRequests: Availability;
    issues: Availability;
    commits: 'available';
  };
  buckets: InsightsBucket[];
  leaderboards: Leaderboards;
  signals: Signal[];
  parameters: typeof DETECTOR_PARAMETERS;
}
