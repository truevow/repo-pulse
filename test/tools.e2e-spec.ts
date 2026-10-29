import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import { InsightsService } from '../src/signals/insights.service';
import { MetricsRepository } from '../src/signals/metrics.repository';
import { FactLedger } from '../src/synthesis/fact-ledger';
import type { ToolContext } from '../src/synthesis/agent/tool-context';
import { buildTools } from '../src/synthesis/agent/tools';
import { loadSnapshot } from '../src/snapshot/snapshot.service';
import {
  EXPECTED_ALICE_ACTIVITY,
  EXPECTED_WEEKS,
  METRICS_FIXTURE,
  METRICS_WINDOW,
  OWNER,
  REPO,
  W1,
  W2,
  W3,
  W4,
} from './fixtures/snapshots/metrics-fixture';
import { createTestApp, resetDatabase } from './setup/db';

const W5 = '2026-10-05';

describe('agent tools (e2e)', () => {
  let app: INestApplication;
  let ctx: ToolContext;

  beforeAll(async () => {
    app = await createTestApp();
    const prisma = app.get(PrismaService);
    await resetDatabase(prisma);
    await loadSnapshot(prisma, METRICS_FIXTURE);
    const insights = await app.get(InsightsService).getInsights(OWNER, REPO, {
      from: W1,
      to: W5,
      bucket: 'week',
      includeBots: false,
    });
    const repository = await prisma.repository.findFirstOrThrow({
      where: { owner: OWNER, name: REPO },
    });
    ctx = {
      repositoryId: repository.id,
      owner: OWNER,
      repo: REPO,
      insights,
      query: {
        repositoryId: repository.id,
        owner: OWNER,
        repo: REPO,
        window: METRICS_WINDOW,
        size: 'week',
        includeBots: false,
      },
      ledger: new FactLedger(),
      metrics: app.get(MetricsRepository),
    };
  });

  afterAll(async () => {
    await app.close();
  });

  const tool = (name: string) => {
    const t = buildTools(ctx).find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t as unknown as {
      parse(input: unknown): unknown;
      run(input: unknown): Promise<string>;
    };
  };

  it('exposes the four tools in order', () => {
    expect(buildTools(ctx).map((t) => t.name)).toEqual([
      'get_metric_series',
      'get_bucket_examples',
      'get_contributor_activity',
      'compare_windows',
    ]);
  });

  it('get_metric_series returns the series and records it', async () => {
    const t = tool('get_metric_series');
    const out = await t.run(t.parse({ metric: 'time_to_first_review_p50_h' }));
    expect(typeof out).toBe('string');
    const res = JSON.parse(out);
    expect(res.unit).toBe('hours');
    expect(res.points.map((p: { value: number | null }) => p.value)).toEqual(
      EXPECTED_WEEKS.map((w) => w.time_to_first_review_p50_h),
    );
    expect(
      ctx.ledger.lookup({ metric: 'time_to_first_review_p50_h', bucket: W1 })
        ?.value,
    ).toBe(4);
  });

  it('get_bucket_examples returns ranked examples and records them', async () => {
    const t = tool('get_bucket_examples');
    const out = await t.run(
      t.parse({ metric: 'time_to_first_review_p50_h', bucket: W1, limit: 3 }),
    );
    const res = JSON.parse(out);
    expect(res.examples.map((e: { ref: string }) => e.ref)).toEqual([
      '#3',
      '#2',
      '#1',
    ]);
    expect(
      ctx.ledger.lookup({
        metric: 'time_to_first_review_p50_h.item',
        bucket: W1,
        entity: '#3',
      })?.value,
    ).toBe(100);
    expect(
      FactLedger.keyOf({
        metric: 'time_to_first_review_p50_h.item',
        bucket: W1,
        entity: '#3',
      }),
    ).toContain('#3');
  });

  it('get_bucket_examples reports an unknown bucket without throwing', async () => {
    const t = tool('get_bucket_examples');
    const res = JSON.parse(
      await t.run(
        t.parse({
          metric: 'time_to_first_review_p50_h',
          bucket: '2020-01-06',
          limit: 3,
        }),
      ),
    );
    expect(res.error).toBe('unknown_bucket');
    expect(res.known).toEqual([W1, W2, W3, W4]);
  });

  it('get_contributor_activity returns rows and records every cell', async () => {
    const t = tool('get_contributor_activity');
    const res = JSON.parse(await t.run(t.parse({ login: 'alice' })));
    expect(res.rows).toEqual(EXPECTED_ALICE_ACTIVITY);
    expect(
      ctx.ledger.lookup({
        metric: 'reviews_given',
        bucket: W1,
        entity: 'alice',
      })?.value,
    ).toBe(3);
    expect(
      ctx.ledger.lookup({ metric: 'commits', bucket: W3, entity: 'alice' })
        ?.value,
    ).toBe(0);
  });

  it('validates logins', () => {
    const t = tool('get_contributor_activity');
    expect(() => t.parse({ login: 'bad login!' })).toThrow();
    expect(() => t.parse({ login: 'renovate[bot]' })).not.toThrow();
  });

  it('compare_windows computes stats and records them', async () => {
    const t = tool('compare_windows');
    const out = await t.run(
      t.parse({
        metric: 'prs_merged',
        a: { from: W1, to: W3 },
        b: { from: W3, to: W5 },
      }),
    );
    const res = JSON.parse(out);
    const v = EXPECTED_WEEKS.map((w) => w.prs_merged as number);
    expect(res.a).toEqual({
      median: (v[0] + v[1]) / 2,
      mean: (v[0] + v[1]) / 2,
      total: v[0] + v[1],
      n: 2,
    });
    expect(res.b).toEqual({
      median: (v[2] + v[3]) / 2,
      mean: (v[2] + v[3]) / 2,
      total: v[2] + v[3],
      n: 2,
    });
    expect(res.delta_median).toBe(res.b.median - res.a.median);
    expect(
      ctx.ledger.lookup({ metric: 'prs_merged.median', bucket: `${W1}/${W3}` })
        ?.value,
    ).toBe(res.a.median);
    expect(
      ctx.ledger.lookup({
        metric: 'prs_merged.delta_median',
        bucket: `${W1}/${W3}|${W3}/${W5}`,
      })?.value,
    ).toBe(res.delta_median);
  });
});
