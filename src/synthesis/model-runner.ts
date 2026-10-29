import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool';
import { ProblemException } from '../common/problem.exception';

export interface ModelRequest {
  system: string;
  user: string;
  tools: BetaRunnableTool[];
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ModelResult {
  /** The model's final answer, JSON-parsed but not yet schema-validated. */
  output: unknown;
  usage: ModelUsage;
  toolCalls: number;
  turns: number;
  /** The model that produced the final turn (may differ under fallback). */
  model: string;
  stopReason: string;
}

export type SynthesisFailureReason =
  'refusal' | 'max_tokens' | 'max_iterations' | 'unparseable';

/** The model ran but produced nothing usable; maps to 502 synthesis-failed. */
export class SynthesisFailedError extends Error {
  constructor(
    public readonly reason: SynthesisFailureReason,
    msg?: string,
  ) {
    super(msg ?? `synthesis failed: ${reason}`);
    this.name = 'SynthesisFailedError';
  }
}

export interface ModelRunner {
  run(req: ModelRequest): Promise<ModelResult>;
}

export const MODEL_RUNNER = Symbol('MODEL_RUNNER');

/** Bound when ANTHROPIC_API_KEY is unset: every run is a 503. */
export class NotConfiguredModelRunner implements ModelRunner {
  run(): Promise<ModelResult> {
    return Promise.reject(
      new ProblemException({
        status: 503,
        type: 'llm-not-configured',
        title: 'LLM not configured',
        detail: 'Set ANTHROPIC_API_KEY to enable narratives',
      }),
    );
  }
}
