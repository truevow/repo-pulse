import Anthropic from '@anthropic-ai/sdk';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ENV, loadEnv } from '../src/config/env';
import { PrismaService } from '../src/prisma/prisma.service';
import type { InsightsResponse } from '../src/signals/insights.types';
import type { Signal } from '../src/signals/signal.types';
import { loadSnapshot } from '../src/snapshot/snapshot.service';
import {
  MODEL_RUNNER,
  NotConfiguredModelRunner,
  SynthesisFailedError,
} from '../src/synthesis/model-runner';
import type { NarrativeResponse } from '../src/synthesis/narrative.types';
import type {
  Evidence,
  Hypothesis,
  SynthesisOutput,
} from '../src/synthesis/output.schema';
import { SYSTEM_PROMPT } from '../src/synthesis/prompts/system.v1';
import { FakeModelRunner } from './fakes/fake-model.runner';
import {
  OWNER,
  REPO,
  W1,
  W4,
  withLatencySpike,
} from './fixtures/snapshots/metrics-fixture';
import {
  PR_DISABLED_COMMITS,
  PR_DISABLED_OWNER,
  PR_DISABLED_REPO,
  prDisabledFixture,
} from './fixtures/snapshots/pr-disabled-fixture';
import { createTestApp, resetDatabase } from './setup/db';

const PROBLEM = 'https://repo-pulse.local/problems/';
const SPIKE_END = '2026-10-19';
const WINDOW = { from: W1, to: SPIKE_END };
const TOOL_NAMES = [
  'get_metric_series',
  'get_bucket_examples',
  'get_contributor_activity',
  'compare_windows',
];

const hyp = (evidence: Evidence[], confidence = 0.55): Hypothesis => ({
  statement: 'Three PRs opened together waited a week for a first review',
  confidence,
  evidence,
  alternative_explanations: ['The usual reviewer was away'],
  suggested_check: 'Ask who was on review rotation that week',
});

const output = (
  hypotheses: Hypothesis[],
  narrative = 'First reviews slowed sharply in one week.',
): SynthesisOutput => ({
  headline: 'First-review latency spiked for one week',
  narrative,
  hypotheses,
  data_caveats: [],
});

/** Two evidence items that the seeded ledger holds exactly. */
const spikeEvidence = (spike: Signal): Evidence[] => [
  {
    signal_id: spike.id,
    metric: spike.metric,
    bucket: spike.bucket,
    entity: null,
    value: spike.observed,
    note: 'median first review in the spike week',
  },
  {
    signal_id: spike.id,
    metric: `${spike.metric}.item`,
    bucket: spike.bucket,
    entity: spike.examples[0].ref,
    value: spike.examples[0].value,
    note: 'slowest PR that week',
  },
];

const bogusEvidence: Evidence = {
  signal_id: null,
  metric: 'made_up_metric',
  bucket: W4,
  entity: null,
  value: 1,
  note: 'not in the data',
};

const expectProblem = (
  res: request.Response,
  status: number,
  type: string,
): void => {
  expect(res.status).toBe(status);
  expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
  expect(res.body).toMatchObject({ status, type: PROBLEM + type });
};

async function spikeApp(
  fake: FakeModelRunner | NotConfiguredModelRunner,
  rateLimit = 1000,
): Promise<INestApplication> {
  return createTestApp([
    { provide: MODEL_RUNNER, useValue: fake },
    {
      provide: ENV,
      useValue: { ...loadEnv(), NARRATIVE_RATE_LIMIT_PER_MIN: rateLimit },
    },
  ]);
}

describe('Narrative (e2e)', () => {
  const fake = new FakeModelRunner([], { delayMs: 50 });
  let app: INestApplication;
  let prisma: PrismaService;
  let spike: Signal;

  const narrative = (
    query: Record<string, string> = WINDOW,
    owner = OWNER,
    repo = REPO,
  ) =>
    request(app.getHttpServer())
      .get(`/api/v1/repos/${owner}/${repo}/narrative`)
      .query(query);

  const insights = async (
    query: Record<string, string>,
  ): Promise<InsightsResponse> =>
    (
      await request(app.getHttpServer())
        .get(`/api/v1/repos/${OWNER}/${REPO}/insights`)
        .query(query)
        .expect(200)
    ).body as InsightsResponse;

  const spikeOf = (body: InsightsResponse): Signal => {
    const found = body.signals.find(
      (s) => s.metric === 'time_to_first_review_p50_h' && s.bucket === W4,
    );
    if (!found) throw new Error('fixture lost its latency spike');
    return found;
  };

  beforeAll(async () => {
    app = await spikeApp(fake);
    prisma = app.get(PrismaService);
    await resetDatabase(prisma);
    await loadSnapshot(prisma, withLatencySpike());
    spike = spikeOf(await insights(WINDOW));
  });

  beforeEach(async () => {
    await prisma.narrative.deleteMany();
    fake.reset([]);
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns a grounded, calibrated narrative for a well-grounded output', async () => {
    const text = `Median first review reached ${spike.observed} hours in the week of ${spike.bucket}.`;
    fake.reset([output([hyp(spikeEvidence(spike))], text)]);

    const res = await narrative().expect(200);
    const body = res.body as NarrativeResponse;

    expect(body.cached).toBe(false);
    expect(body.repository).toMatchObject({ owner: OWNER, name: REPO });
    expect(body.window).toEqual({
      from: `${W1}T00:00:00.000Z`,
      to: `${SPIKE_END}T00:00:00.000Z`,
    });
    expect(body.bucket).toBe('week');
    expect(body.headline).toBe('First-review latency spiked for one week');
    expect(body.narrative).toBe(text);
    expect(body.grounding).toEqual({
      status: 'ok',
      rejected: [],
      unverifiedNumbers: [],
      droppedHypotheses: 0,
    });
    expect(body.hypotheses).toHaveLength(1);
    expect(body.hypotheses[0]).toMatchObject({
      model_confidence: 0.55,
      confidence: 0.55,
      adjustments: [],
      evidence: spikeEvidence(spike),
    });
    expect(body.meta).toMatchObject({
      model: 'fake',
      promptVersion: 'v1',
      toolCalls: 0,
      turns: 1,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
      },
    });
    expect(body.meta.latencyMs).toBeGreaterThanOrEqual(0);
    expect(Date.parse(body.generatedAt)).not.toBeNaN();

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].system).toBe(SYSTEM_PROMPT);
    expect(fake.calls[0].user).toContain(spike.id);
    expect(fake.calls[0].user).toContain('METRICS (CSV)');
    expect(fake.calls[0].tools.map((t) => t.name)).toEqual(TOOL_NAMES);

    const rows = await prisma.narrative.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ promptVersion: 'v1', model: 'fake' });
  });

  it('serves a repeat from the cache and regenerates on refresh=true', async () => {
    fake.reset([
      output([hyp(spikeEvidence(spike))]),
      output([hyp(spikeEvidence(spike))]),
    ]);

    const first = (await narrative().expect(200)).body as NarrativeResponse;
    const second = (await narrative().expect(200)).body as NarrativeResponse;
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.generatedAt).toBe(first.generatedAt);
    expect(second.hypotheses).toEqual(first.hypotheses);
    expect(fake.calls).toHaveLength(1);

    const refreshed = (
      await narrative({ ...WINDOW, refresh: 'true' }).expect(200)
    ).body as NarrativeResponse;
    expect(refreshed.cached).toBe(false);
    expect(fake.calls).toHaveLength(2);
    expect(await prisma.narrative.count()).toBe(1);
  });

  it('runs the model once for two concurrent identical requests', async () => {
    fake.reset([output([hyp(spikeEvidence(spike))])]);

    const [a, b] = await Promise.all([narrative(), narrative()]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect((a.body as NarrativeResponse).cached).toBe(false);
    expect((b.body as NarrativeResponse).cached).toBe(false);
    expect(fake.calls).toHaveLength(1);
    expect((a.body as NarrativeResponse).generatedAt).toBe(
      (b.body as NarrativeResponse).generatedAt,
    );
  });

  it('rejects a wrong value and an unknown signal id, keeping the hypothesis (partial)', async () => {
    const wrongValue: Evidence = {
      ...spikeEvidence(spike)[0],
      value: spike.observed + 50,
    };
    const unknownSignal: Evidence = {
      ...spikeEvidence(spike)[0],
      signal_id: 'no-such-signal',
    };
    fake.reset([
      output([hyp([...spikeEvidence(spike), wrongValue, unknownSignal])]),
    ]);

    const body = (await narrative().expect(200)).body as NarrativeResponse;

    expect(body.grounding.status).toBe('partial');
    expect(body.grounding.droppedHypotheses).toBe(0);
    expect(body.grounding.rejected).toEqual([
      {
        hypothesisIndex: 0,
        evidence: wrongValue,
        reason: 'value_mismatch',
        expected: spike.observed,
      },
      { hypothesisIndex: 0, evidence: unknownSignal, reason: 'unknown_signal' },
    ]);
    expect(body.hypotheses[0].evidence).toEqual(spikeEvidence(spike));
    expect(body.hypotheses[0].adjustments).toEqual(['evidence_rejected']);
    expect(body.hypotheses[0].confidence).toBe(0.44);
  });

  it('drops a hypothesis whose only evidence is bogus (failed, still 200)', async () => {
    fake.reset([output([hyp([bogusEvidence])])]);

    const body = (await narrative().expect(200)).body as NarrativeResponse;

    expect(body.grounding.status).toBe('failed');
    expect(body.grounding.droppedHypotheses).toBe(1);
    expect(body.grounding.rejected).toEqual([
      { hypothesisIndex: 0, evidence: bogusEvidence, reason: 'unknown_fact' },
    ]);
    expect(body.hypotheses).toEqual([]);
    expect(body.narrative).toBe('First reviews slowed sharply in one week.');
  });

  it('counts rejections against the original hypothesis index', async () => {
    // Hypothesis 0 is dropped; the survivor (originally 1) had no rejections.
    fake.reset([
      output([hyp([bogusEvidence]), hyp(spikeEvidence(spike), 0.5)]),
    ]);

    const body = (await narrative().expect(200)).body as NarrativeResponse;

    expect(body.grounding.status).toBe('partial');
    expect(body.hypotheses).toHaveLength(1);
    expect(body.hypotheses[0]).toMatchObject({
      confidence: 0.5,
      adjustments: [],
    });
  });

  it('502 synthesis-failed when the output has the wrong shape', async () => {
    fake.reset([{ headline: 1, narrative: 'x' }]);
    const res = await narrative();
    expectProblem(res, 502, 'synthesis-failed');
    expect(res.body).toMatchObject({
      detail: 'unparseable',
      reason: 'unparseable',
    });
    expect(await prisma.narrative.count()).toBe(0);
  });

  it('502 synthesis-failed when the model refuses', async () => {
    fake.reset([new SynthesisFailedError('refusal')]);
    const res = await narrative();
    expectProblem(res, 502, 'synthesis-failed');
    expect(res.body.detail).toBe('refusal');
  });

  it('503 llm-unavailable with Retry-After when the provider rate-limits, then recovers', async () => {
    fake.reset([
      new Anthropic.RateLimitError(
        429,
        { message: 'slow down' },
        'slow down',
        new Headers(),
      ),
      output([hyp(spikeEvidence(spike))]),
    ]);

    const res = await narrative();
    expectProblem(res, 503, 'llm-unavailable');
    expect(res.headers['retry-after']).toBe('30');
    expect(JSON.stringify(res.body)).not.toContain('slow down');

    // The failed generation released its in-flight slot.
    const retry = (await narrative().expect(200)).body as NarrativeResponse;
    expect(retry.cached).toBe(false);
    expect(fake.calls).toHaveLength(2);
  });

  it('503 llm-unavailable on a connection error and llm-not-configured on bad credentials', async () => {
    fake.reset([
      new Anthropic.APIConnectionError({ message: 'socket hang up' }),
      new Anthropic.AuthenticationError(
        401,
        { message: 'bad key' },
        'bad key',
        new Headers(),
      ),
    ]);

    const down = await narrative();
    expectProblem(down, 503, 'llm-unavailable');
    expect(down.headers['retry-after']).toBe('30');

    const auth = await narrative();
    expectProblem(auth, 503, 'llm-not-configured');
    expect(auth.headers['retry-after']).toBeUndefined();
  });

  it('502 synthesis-failed upstream_<status> for any other provider error, without its message', async () => {
    fake.reset([
      new Anthropic.NotFoundError(
        404,
        { message: 'model: claude-typo not found' },
        'model: claude-typo not found',
        new Headers(),
      ),
      new Anthropic.BadRequestError(
        400,
        { message: 'prompt too long' },
        'prompt too long',
        new Headers(),
      ),
    ]);

    const missing = await narrative();
    expectProblem(missing, 502, 'synthesis-failed');
    expect(missing.body.detail).toBe('upstream_404');
    expect(JSON.stringify(missing.body)).not.toContain('claude-typo');

    const bad = await narrative();
    expectProblem(bad, 502, 'synthesis-failed');
    expect(bad.body.detail).toBe('upstream_400');
    expect(JSON.stringify(bad.body)).not.toContain('prompt too long');
  });

  it('caps confidence for a window beyond coverage (partial_data)', async () => {
    const wide = { from: W1, to: '2026-10-26' };
    const wideBody = await insights(wide);
    expect(wideBody.coverage.partial).toBe(true);
    const wideSpike = spikeOf(wideBody);
    fake.reset([output([hyp(spikeEvidence(wideSpike), 0.9)])]);

    const body = (await narrative(wide).expect(200)).body as NarrativeResponse;

    expect(body.grounding.status).toBe('ok');
    expect(body.hypotheses[0].model_confidence).toBe(0.9);
    expect(body.hypotheses[0].adjustments).toContain('partial_data');
    expect(body.hypotheses[0].confidence).toBeLessThanOrEqual(0.5);
  });

  it('400 on an invalid refresh flag; 404 for an unsynced repository', async () => {
    expectProblem(
      await narrative({ ...WINDOW, refresh: 'maybe' }),
      400,
      'validation-error',
    );
    expectProblem(
      await narrative(WINDOW, OWNER, 'unknown'),
      404,
      'repo-not-synced',
    );
    expect(fake.calls).toHaveLength(0);
  });

  describe('other repositories', () => {
    beforeAll(async () => {
      await loadSnapshot(prisma, prDisabledFixture());
      await loadSnapshot(prisma, {
        ...prDisabledFixture(),
        repository: {
          ...prDisabledFixture().repository,
          githubId: 'R_empty',
          name: 'empty',
        },
        actors: [],
        commits: [],
      });
    });

    it('caps confidence when pull requests are unavailable', async () => {
      const window = { from: W1, to: '2026-10-05' };
      const commitsEvidence = Object.entries(PR_DISABLED_COMMITS)
        .filter(([, n]) => n > 0)
        .slice(0, 2)
        .map(([bucket, value]): Evidence => ({
          signal_id: null,
          metric: 'commits',
          bucket,
          entity: null,
          value,
          note: 'weekly commits',
        }));
      fake.reset([output([hyp(commitsEvidence, 0.9)])]);

      const body = (
        await narrative(window, PR_DISABLED_OWNER, PR_DISABLED_REPO).expect(200)
      ).body as NarrativeResponse;

      expect(body.grounding.status).toBe('ok');
      expect(body.hypotheses[0].model_confidence).toBe(0.9);
      // No signal exists here, so the 0.5 no-signal cap applies first and
      // partial_data changes nothing (see narrative.service.spec.ts for it).
      expect(body.hypotheses[0].adjustments).toEqual(['no_signal_cited']);
      expect(body.hypotheses[0].confidence).toBe(0.5);
      expect(fake.calls[0].user).toContain('pullRequests unavailable');
    });

    it('409 no-signal-data for a repository with no activity at all', async () => {
      const res = await narrative(
        { from: W1, to: '2026-10-05' },
        PR_DISABLED_OWNER,
        'empty',
      );
      expectProblem(res, 409, 'no-signal-data');
      expect(fake.calls).toHaveLength(0);
    });
  });
});

describe('Narrative throttling (e2e)', () => {
  const fake = new FakeModelRunner();
  let app: INestApplication;

  beforeAll(async () => {
    app = await spikeApp(fake, 3);
    const prisma = app.get(PrismaService);
    await resetDatabase(prisma);
    await loadSnapshot(prisma, withLatencySpike());
  });

  afterAll(async () => {
    await app.close();
  });

  it('429 rate-limited with Retry-After on the 4th request in a minute', async () => {
    fake.reset([output([])]);
    const get = () =>
      request(app.getHttpServer())
        .get(`/api/v1/repos/${OWNER}/${REPO}/narrative`)
        .query(WINDOW);

    for (let i = 0; i < 3; i += 1) await get().expect(200);
    const res = await get();

    expectProblem(res, 429, 'rate-limited');
    expect(res.headers['retry-after']).toBeDefined();
    expect(fake.calls).toHaveLength(1);

    // Other controllers are not throttled.
    await request(app.getHttpServer())
      .get(`/api/v1/repos/${OWNER}/${REPO}/insights`)
      .query(WINDOW)
      .expect(200);
  });
});

describe('Narrative without an API key (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await spikeApp(new NotConfiguredModelRunner());
    const prisma = app.get(PrismaService);
    await resetDatabase(prisma);
    await loadSnapshot(prisma, withLatencySpike());
  });

  afterAll(async () => {
    await app.close();
  });

  it('503 llm-not-configured', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/repos/${OWNER}/${REPO}/narrative`)
      .query(WINDOW);
    expectProblem(res, 503, 'llm-not-configured');
  });
});
