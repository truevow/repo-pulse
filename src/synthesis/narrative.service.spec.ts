import { loadEnv } from '../config/env';
import type { InsightsResponse } from '../signals/insights.types';
import { METRIC_NAMES } from '../signals/metric-names';
import {
  INSIGHTS_FIXTURE,
  OUTLIER_SIGNAL,
} from '../../test/fixtures/insights.fixture';
import { FakeModelRunner } from '../../test/fakes/fake-model.runner';
import { NarrativeService } from './narrative.service';
import type { NarrativeResponse } from './narrative.types';
import type { Evidence, SynthesisOutput } from './output.schema';

const Q = { bucket: 'week' as const, includeBots: false, refresh: false };

/** Two items the seeded ledger holds for the high-severity outlier signal. */
const OUTLIER_EVIDENCE: Evidence[] = [
  {
    signal_id: OUTLIER_SIGNAL.id,
    metric: OUTLIER_SIGNAL.metric,
    bucket: OUTLIER_SIGNAL.bucket,
    entity: null,
    value: OUTLIER_SIGNAL.observed,
    note: 'spike',
  },
  {
    signal_id: OUTLIER_SIGNAL.id,
    metric: `${OUTLIER_SIGNAL.metric}.item`,
    bucket: OUTLIER_SIGNAL.bucket,
    entity: '#123',
    value: 100.25,
    note: 'slowest',
  },
];

const output = (confidence = 0.9): SynthesisOutput => ({
  headline: 'h',
  narrative: 'The narrative text never reaches the logs.',
  hypotheses: [
    {
      statement: 's',
      confidence,
      evidence: OUTLIER_EVIDENCE,
      alternative_explanations: [],
      suggested_check: 'c',
    },
  ],
  data_caveats: [],
});

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(
  insights: InsightsResponse = INSIGHTS_FIXTURE,
  opts: { stored?: NarrativeResponse; lookupDelayMs?: number } = {},
) {
  const runner = new FakeModelRunner([], { delayMs: 10 });
  const prisma = {
    narrative: {
      findUnique: jest.fn(async () => {
        if (opts.lookupDelayMs) await delay(opts.lookupDelayMs);
        return opts.stored ? { result: opts.stored } : null;
      }),
      upsert: jest.fn(() => Promise.resolve({})),
    },
    repository: {
      findUniqueOrThrow: jest.fn(() => Promise.resolve({ id: 1 })),
    },
  };
  const logger = { setContext: jest.fn(), info: jest.fn(), warn: jest.fn() };
  const service = new NarrativeService(
    { getInsights: jest.fn(() => Promise.resolve(insights)) } as never,
    {} as never,
    prisma as never,
    runner,
    loadEnv({ DATABASE_URL: 'postgresql://unused' }),
    logger as never,
  );
  return { service, runner, prisma, logger };
}

/** A response as the service itself would store it. */
async function storedResponse(): Promise<NarrativeResponse> {
  const { service, runner, prisma } = setup();
  runner.reset([output()]);
  await service.getNarrative('acme', 'widgets', Q);
  const args = prisma.narrative.upsert.mock.calls[0] as unknown as [
    { create: { result: NarrativeResponse } },
  ];
  return args[0].create.result;
}

describe('NarrativeService', () => {
  it('applies partial_data for a cited high signal when pull requests are unavailable', async () => {
    const { service, runner } = setup({
      ...INSIGHTS_FIXTURE,
      availability: {
        ...INSIGHTS_FIXTURE.availability,
        pullRequests: 'unavailable',
      },
    });
    runner.reset([output(0.9)]);

    const r = await service.getNarrative('acme', 'widgets', Q);

    expect(r.grounding.status).toBe('ok');
    expect(r.hypotheses[0]).toMatchObject({
      model_confidence: 0.9,
      confidence: 0.5,
      adjustments: ['partial_data'],
    });
  });

  it('leaves the same hypothesis uncapped when everything is available, and logs the generation', async () => {
    const { service, runner, logger } = setup();
    runner.reset([output(0.9)]);
    const r = await service.getNarrative('acme', 'widgets', Q);
    expect(r.hypotheses[0]).toMatchObject({ confidence: 0.9, adjustments: [] });
    const [fields] = logger.info.mock.calls[0] as [Record<string, unknown>];
    expect(fields).toMatchObject({ cached: false, turns: 1, model: 'fake' });
    expect(JSON.stringify(fields)).not.toContain(r.narrative);
  });

  it('409 no-signal-data when no bucket has a non-zero value, even with signals', async () => {
    const empty = Object.fromEntries(
      METRIC_NAMES.map((m, i) => [m, i % 2 ? 0 : null]),
    ) as InsightsResponse['buckets'][number]['metrics'];
    const { service, runner } = setup({
      ...INSIGHTS_FIXTURE,
      buckets: INSIGHTS_FIXTURE.buckets.map((b) => ({ ...b, metrics: empty })),
    });
    expect(INSIGHTS_FIXTURE.signals.length).toBeGreaterThan(0);

    await expect(
      service.getNarrative('acme', 'widgets', Q),
    ).rejects.toMatchObject({
      problem: { status: 409, type: 'no-signal-data' },
    });
    expect(runner.calls).toHaveLength(0);
  });

  it('logs a cache hit as cached, with zero usage and its own latency, never the text', async () => {
    const stored = await storedResponse();
    const { service, runner, logger } = setup(INSIGHTS_FIXTURE, { stored });

    const r = await service.getNarrative('acme', 'widgets', Q, 'req-1');

    expect(r.cached).toBe(true);
    expect(r.meta.usage).toEqual(stored.meta.usage);
    expect(runner.calls).toHaveLength(0);
    expect(logger.info).toHaveBeenCalledTimes(1);
    const [fields, msg] = logger.info.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(msg).toBe('narrative');
    expect(fields).toMatchObject({
      requestId: 'req-1',
      cached: true,
      toolCalls: 0,
      turns: 0,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
      },
      groundingStatus: 'ok',
    });
    expect(typeof fields.latencyMs).toBe('number');
    expect(JSON.stringify(fields)).not.toContain(stored.narrative);
  });

  it('looks up a different cache key after a re-sync or a changed number', async () => {
    const keyFor = async (insights: InsightsResponse) => {
      const { service, prisma } = setup(insights, {
        stored: await storedResponse(),
      });
      await service.getNarrative('acme', 'widgets', Q);
      const [args] = prisma.narrative.findUnique.mock.calls[0] as unknown as [
        { where: { cacheKey: string } },
      ];
      return args.where.cacheKey;
    };
    const base = await keyFor(INSIGHTS_FIXTURE);
    const resynced = await keyFor({
      ...INSIGHTS_FIXTURE,
      coverage: {
        ...INSIGHTS_FIXTURE.coverage,
        lastSyncedAt: '2026-09-15T00:00:00.000Z',
      },
    });
    const [w1, w2] = INSIGHTS_FIXTURE.buckets;
    const recounted = await keyFor({
      ...INSIGHTS_FIXTURE,
      buckets: [w1, { ...w2, metrics: { ...w2.metrics, commits: 31 } }],
    });
    expect(new Set([base, resynced, recounted]).size).toBe(3);
  });

  it('does not let refresh=true join an in-flight cache lookup', async () => {
    const stored = await storedResponse();
    const { service, runner } = setup(INSIGHTS_FIXTURE, {
      stored,
      lookupDelayMs: 30,
    });
    runner.reset([output()]);

    const [lookup, refreshed] = await Promise.all([
      service.getNarrative('acme', 'widgets', Q),
      service.getNarrative('acme', 'widgets', { ...Q, refresh: true }),
    ]);

    expect(lookup.cached).toBe(true);
    expect(refreshed.cached).toBe(false);
    expect(runner.calls).toHaveLength(1);
  });

  it('lets a cache miss join a refresh generation already in flight', async () => {
    const { service, runner } = setup();
    runner.reset([output()]);

    const [refreshed, miss] = await Promise.all([
      service.getNarrative('acme', 'widgets', { ...Q, refresh: true }),
      service.getNarrative('acme', 'widgets', Q),
    ]);

    expect(runner.calls).toHaveLength(1);
    expect(miss).toBe(refreshed);
  });
});
