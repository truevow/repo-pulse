export type FactUnit = 'count' | 'hours' | 'ratio' | 'lines';

export const METRIC_NAMES = [
  'prs_opened',
  'prs_merged',
  'prs_closed_unmerged',
  'time_to_first_review_p50_h',
  'time_to_merge_p50_h',
  'reviews_submitted',
  'approvals',
  'review_concentration_top1',
  'review_concentration_hhi',
  'issues_opened',
  'issues_closed',
  'issue_time_to_close_p50_h',
  'commits',
  'active_authors',
  'bus_factor_50',
] as const;

export type MetricName = (typeof METRIC_NAMES)[number];

function unitOf(metric: MetricName): FactUnit {
  if (metric.endsWith('_p50_h')) return 'hours';
  if (metric.startsWith('review_concentration_')) return 'ratio';
  return 'count';
}

export const METRIC_UNITS = Object.fromEntries(
  METRIC_NAMES.map((m) => [m, unitOf(m)]),
) as Record<MetricName, FactUnit>;
