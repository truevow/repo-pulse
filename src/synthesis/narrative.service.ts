import Anthropic from '@anthropic-ai/sdk';
import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { ZodError } from 'zod';
import { ProblemException } from '../common/problem.exception';
import { ENV, type Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { InsightsService } from '../signals/insights.service';
import type { InsightsResponse } from '../signals/insights.types';
import { MetricsRepository } from '../signals/metrics.repository';
import type { ToolContext } from './agent/tool-context';
import { buildTools } from './agent/tools';
import { narrativeCacheKey, signalsFingerprint } from './cache-key';
import { calibrate } from './calibration';
import { FactLedger, seedLedgerFromInsights } from './fact-ledger';
import { groundOutput } from './grounding';
import {
  MODEL_RUNNER,
  SynthesisFailedError,
  type ModelResult,
  type ModelRunner,
  type ModelUsage,
} from './model-runner';
import type {
  NarrativeQuery,
  NarrativeResponse,
  NarrativeUsage,
} from './narrative.types';
import { SynthesisOutputSchema, type SynthesisOutput } from './output.schema';
import { PROMPT_VERSION, SYSTEM_PROMPT } from './prompts/system.v1';
import { buildUserMessage } from './prompts/user-message';

/** USD per million tokens (Claude Opus 5.5 list prices); an estimate under fallback. */
const PRICE_PER_MTOK = {
  input: 4,
  output: 20,
  cacheRead: 0.2,
  cacheWrite: 5,
};

export function costUsd(u: ModelUsage): number {
  const dollars =
    (u.inputTokens * PRICE_PER_MTOK.input +
      u.outputTokens * PRICE_PER_MTOK.output +
      u.cacheReadTokens * PRICE_PER_MTOK.cacheRead +
      u.cacheWriteTokens * PRICE_PER_MTOK.cacheWrite) /
    1_000_000;
  return Math.round(dollars * 1e6) / 1e6;
}

const RETRY_AFTER_S = '30';

/** Maps model and provider failures onto problem details; anything else propagates. */
function toProblem(err: unknown): unknown {
  if (err instanceof ProblemException) return err;
  if (err instanceof SynthesisFailedError) {
    return new ProblemException({
      status: 502,
      type: 'synthesis-failed',
      title: 'Synthesis failed',
      detail: err.reason,
      extensions: { reason: err.reason },
    });
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return new ProblemException({
      status: 503,
      type: 'llm-not-configured',
      title: 'LLM not configured',
      detail: 'The Anthropic API rejected the configured credentials',
    });
  }
  if (
    err instanceof Anthropic.RateLimitError ||
    err instanceof Anthropic.APIConnectionError ||
    err instanceof Anthropic.InternalServerError
  ) {
    return new ProblemException({
      status: 503,
      type: 'llm-unavailable',
      title: 'LLM unavailable',
      detail: 'The model provider is unavailable; retry later',
      headers: { 'Retry-After': RETRY_AFTER_S },
    });
  }
  return err;
}

/** 409 when there is nothing to reason about: no available entity, or no activity and no signals. */
function assertHasData(insights: InsightsResponse): void {
  const allUnavailable = Object.values(insights.availability).every(
    (a) => a === 'unavailable',
  );
  // Counts are 0 (not null) in empty buckets, so zero means no activity too.
  const anyActivity = insights.buckets.some((b) =>
    Object.values(b.metrics).some((v) => v !== null && v !== 0),
  );
  if (allUnavailable || (!anyActivity && insights.signals.length === 0)) {
    throw new ProblemException({
      status: 409,
      type: 'no-signal-data',
      title: 'No signal data',
      detail: 'The window has no activity or signals to reason about',
    });
  }
}

@Injectable()
export class NarrativeService {
  private readonly inFlight = new Map<string, Promise<NarrativeResponse>>();

  constructor(
    private readonly insights: InsightsService,
    private readonly metrics: MetricsRepository,
    private readonly prisma: PrismaService,
    @Inject(MODEL_RUNNER) private readonly runner: ModelRunner,
    @Inject(ENV) private readonly env: Env,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(NarrativeService.name);
  }

  async getNarrative(
    owner: string,
    repo: string,
    q: NarrativeQuery,
    requestId?: string,
  ): Promise<NarrativeResponse> {
    const insights = await this.insights.getInsights(owner, repo, q);
    assertHasData(insights);

    const key = narrativeCacheKey({
      owner: insights.repository.owner,
      repo: insights.repository.name,
      from: insights.window.from,
      to: insights.window.to,
      bucket: insights.bucket,
      includeBots: insights.includeBots,
      signalsFingerprint: signalsFingerprint(insights.signals),
      promptVersion: PROMPT_VERSION,
      model: this.env.ANTHROPIC_MODEL,
      effort: this.env.ANTHROPIC_EFFORT,
    });

    // Concurrent identical requests share one generation (or one lookup).
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const task = this.resolve(key, insights, q.refresh, requestId).finally(() =>
      this.inFlight.delete(key),
    );
    this.inFlight.set(key, task);
    return task;
  }

  private async resolve(
    key: string,
    insights: InsightsResponse,
    refresh: boolean,
    requestId?: string,
  ): Promise<NarrativeResponse> {
    if (!refresh) {
      const hit = await this.prisma.narrative.findUnique({
        where: { cacheKey: key },
      });
      if (hit) {
        const stored = hit.result as unknown as NarrativeResponse;
        this.logGeneration(requestId, { ...stored, cached: true });
        return { ...stored, cached: true };
      }
    }
    return this.generate(key, insights, requestId);
  }

  private async generate(
    key: string,
    insights: InsightsResponse,
    requestId?: string,
  ): Promise<NarrativeResponse> {
    const started = Date.now();
    const { owner, name } = insights.repository;
    const repository = await this.prisma.repository.findUniqueOrThrow({
      where: { owner_name: { owner, name } },
    });

    const ledger = new FactLedger();
    seedLedgerFromInsights(ledger, insights);
    const ctx: ToolContext = {
      repositoryId: repository.id,
      owner,
      repo: name,
      insights,
      query: {
        repositoryId: repository.id,
        owner,
        repo: name,
        window: {
          from: new Date(insights.window.from),
          to: new Date(insights.window.to),
        },
        size: insights.bucket,
        includeBots: insights.includeBots,
      },
      ledger,
      metrics: this.metrics,
    };

    let result: ModelResult;
    let output: SynthesisOutput;
    try {
      result = await this.runner.run({
        system: SYSTEM_PROMPT,
        user: buildUserMessage(insights),
        tools: buildTools(ctx),
      });
      output = this.validate(result.output);
    } catch (err) {
      this.logger.warn(
        {
          requestId,
          owner,
          repo: name,
          promptVersion: PROMPT_VERSION,
          error: err instanceof Error ? err.name : typeof err,
          reason: err instanceof SynthesisFailedError ? err.reason : undefined,
        },
        'narrative generation failed',
      );
      throw toProblem(err);
    }

    const grounding = groundOutput(output, ledger, insights.signals);
    const signalsById = new Map(insights.signals.map((s) => [s.id, s]));
    const anyUnavailable = Object.values(insights.availability).some(
      (a) => a === 'unavailable',
    );
    const hypotheses = grounding.output.hypotheses.map((h, i) => {
      const original = grounding.survivingIndices[i];
      return calibrate(h, {
        signalsById,
        coveragePartial: insights.coverage.partial,
        anyUnavailable,
        rejectedCount: grounding.rejected.filter(
          (r) => r.hypothesisIndex === original,
        ).length,
      });
    });

    const usage: NarrativeUsage = {
      ...result.usage,
      costUsd: costUsd(result.usage),
    };
    const response: NarrativeResponse = {
      repository: insights.repository,
      window: insights.window,
      bucket: insights.bucket,
      cached: false,
      generatedAt: new Date().toISOString(),
      headline: grounding.output.headline,
      narrative: grounding.output.narrative,
      hypotheses,
      data_caveats: grounding.output.data_caveats,
      grounding: {
        status: grounding.status,
        rejected: grounding.rejected,
        unverifiedNumbers: grounding.unverifiedNumbers,
        droppedHypotheses: grounding.droppedHypotheses,
      },
      meta: {
        model: result.model,
        promptVersion: PROMPT_VERSION,
        usage,
        toolCalls: result.toolCalls,
        turns: result.turns,
        latencyMs: Date.now() - started,
      },
    };

    const row = {
      repositoryId: repository.id,
      promptVersion: PROMPT_VERSION,
      model: result.model,
      result: response as unknown as Prisma.InputJsonValue,
      usage: usage as unknown as Prisma.InputJsonValue,
    };
    await this.prisma.narrative.upsert({
      where: { cacheKey: key },
      create: { cacheKey: key, ...row },
      update: { ...row, createdAt: new Date() },
    });

    this.logGeneration(requestId, response);
    return response;
  }

  private validate(output: unknown): SynthesisOutput {
    try {
      return SynthesisOutputSchema.parse(output);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new SynthesisFailedError(
          'unparseable',
          'output does not match the schema',
        );
      }
      throw err;
    }
  }

  /** Metadata only: never the prompt or the narrative text. */
  private logGeneration(
    requestId: string | undefined,
    r: NarrativeResponse,
  ): void {
    this.logger.info(
      {
        requestId,
        owner: r.repository.owner,
        repo: r.repository.name,
        cached: r.cached,
        model: r.meta.model,
        promptVersion: r.meta.promptVersion,
        usage: r.meta.usage,
        toolCalls: r.meta.toolCalls,
        turns: r.meta.turns,
        latencyMs: r.meta.latencyMs,
        groundingStatus: r.grounding.status,
      },
      'narrative',
    );
  }
}
