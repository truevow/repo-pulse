import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool';
import * as z from 'zod';
import {
  METRIC_NAMES,
  METRIC_UNITS,
  type MetricName,
} from '../../signals/metric-names';
import type { InsightsBucket } from '../../signals/insights.types';
import type { ToolContext, ToolName } from './tool-context';

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  get_metric_series:
    'Return the full per-bucket series for one metric, with a partial flag per bucket. Use it to see the shape of a metric over the window before judging a signal; level-shift signals cite `<metric>.observed` for the recent median.',
  get_bucket_examples:
    'Return the pull requests, issues or commits that contributed most to a metric in one bucket, with titles, authors and the relevant duration or count. Use it to see what was behind a spike before naming a cause.',
  get_contributor_activity:
    "Return one contributor's per-bucket pull requests opened and merged, reviews given and commits. Use it to check whether a person explains a change in a metric.",
  compare_windows:
    'Compare one metric across two sub-windows using complete buckets only, returning median, mean, total and bucket count for each and the change in median. Use it to quantify a before and after claim.',
};

const MAX_EXAMPLES = 10;
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const METRIC = z.enum(METRIC_NAMES);
const WINDOW = z.object({ from: DATE, to: DATE });
type Win = z.infer<typeof WINDOW>;

const json = (v: unknown): string => JSON.stringify(v);
const day = (iso: string): string => iso.slice(0, 10);

function bucketByKey(
  ctx: ToolContext,
  key: string,
): InsightsBucket | undefined {
  return ctx.insights.buckets.find((b) => b.key === key);
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function windowStats(ctx: ToolContext, metric: MetricName, w: Win) {
  const values = ctx.insights.buckets
    .filter((b) => !b.partial && day(b.start) >= w.from && day(b.end) <= w.to)
    .map((b) => b.metrics[metric])
    .filter((v): v is number => v !== null)
    .sort((x, y) => x - y);
  if (values.length === 0)
    return { median: null, mean: null, total: null, n: 0 };
  const total = values.reduce((s, v) => s + v, 0);
  return {
    median: median(values),
    mean: total / values.length,
    total,
    n: values.length,
  };
}

function metricSeries(ctx: ToolContext) {
  return betaZodTool({
    name: 'get_metric_series',
    description: TOOL_DESCRIPTIONS.get_metric_series,
    inputSchema: z.object({ metric: METRIC }),
    strict: true,
    run: ({ metric }) => {
      const unit = METRIC_UNITS[metric];
      const points = ctx.insights.buckets.map((b) => ({
        bucket: b.key,
        value: b.metrics[metric],
        partial: b.partial,
      }));
      for (const p of points) {
        if (p.value !== null)
          ctx.ledger.record({ metric, bucket: p.bucket }, p.value, unit);
      }
      const unavailable = points.every((p) => p.value === null);
      return json({
        metric,
        unit,
        points,
        ...(unavailable && { note: 'unavailable for this repository' }),
      });
    },
  });
}

function bucketExamples(ctx: ToolContext) {
  return betaZodTool({
    name: 'get_bucket_examples',
    description: TOOL_DESCRIPTIONS.get_bucket_examples,
    inputSchema: z.object({
      metric: METRIC,
      bucket: DATE,
      // Strict tool schemas reject numeric bounds, so the range is described
      // here and enforced in `run`.
      limit: z.number().describe('How many items, 1 to 10'),
    }),
    strict: true,
    run: async ({ metric, bucket, limit: requested }) => {
      const limit = Math.min(MAX_EXAMPLES, Math.max(1, Math.round(requested)));
      const found = bucketByKey(ctx, bucket);
      if (!found) {
        return json({
          error: 'unknown_bucket',
          known: ctx.insights.buckets.map((b) => b.key),
        });
      }
      const examples = await ctx.metrics.bucketExamples({
        ...ctx.query,
        metric,
        bucketStart: new Date(found.start),
        limit,
      });
      for (const e of examples) {
        ctx.ledger.record(
          { metric: `${metric}.item`, bucket, entity: e.ref },
          e.value,
          e.unit,
        );
      }
      return json({ metric, bucket, examples });
    },
  });
}

const ACTIVITY_METRICS = [
  'prs_opened',
  'prs_merged',
  'reviews_given',
  'commits',
] as const;

function contributorActivity(ctx: ToolContext) {
  return betaZodTool({
    name: 'get_contributor_activity',
    description: TOOL_DESCRIPTIONS.get_contributor_activity,
    inputSchema: z.object({
      login: z.string().regex(/^[A-Za-z0-9-]{1,39}(\[bot\])?$/),
    }),
    strict: true,
    run: async ({ login }) => {
      const rows = await ctx.metrics.contributorActivity({
        ...ctx.query,
        login,
      });
      for (const row of rows) {
        for (const metric of ACTIVITY_METRICS) {
          ctx.ledger.record(
            { metric, bucket: row.bucket, entity: login },
            row[metric],
            'count',
          );
        }
      }
      return json({ login, rows });
    },
  });
}

const label = (w: Win): string => `${w.from}/${w.to}`;

function recordStats(
  ctx: ToolContext,
  metric: MetricName,
  w: Win,
  s: ReturnType<typeof windowStats>,
): void {
  if (s.median === null || s.mean === null || s.total === null) return;
  const unit = METRIC_UNITS[metric];
  const bucket = label(w);
  ctx.ledger.record({ metric: `${metric}.median`, bucket }, s.median, unit);
  ctx.ledger.record({ metric: `${metric}.mean`, bucket }, s.mean, unit);
  ctx.ledger.record({ metric: `${metric}.total`, bucket }, s.total, unit);
  ctx.ledger.record({ metric: `${metric}.n`, bucket }, s.n, 'count');
}

function compareWindows(ctx: ToolContext) {
  return betaZodTool({
    name: 'compare_windows',
    description: TOOL_DESCRIPTIONS.compare_windows,
    inputSchema: z.object({ metric: METRIC, a: WINDOW, b: WINDOW }),
    strict: true,
    run: ({ metric, a, b }) => {
      const sa = windowStats(ctx, metric, a);
      const sb = windowStats(ctx, metric, b);
      recordStats(ctx, metric, a, sa);
      recordStats(ctx, metric, b, sb);
      const delta =
        sa.median === null || sb.median === null ? null : sb.median - sa.median;
      if (delta !== null) {
        ctx.ledger.record(
          {
            metric: `${metric}.delta_median`,
            bucket: `${label(a)}|${label(b)}`,
          },
          delta,
          METRIC_UNITS[metric],
        );
      }
      return json({ metric, a: sa, b: sb, delta_median: delta });
    },
  });
}

export function buildTools(ctx: ToolContext): BetaRunnableTool[] {
  return [
    metricSeries(ctx),
    bucketExamples(ctx),
    contributorActivity(ctx),
    compareWindows(ctx),
  ];
}
