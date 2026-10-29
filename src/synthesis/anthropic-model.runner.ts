import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import {
  SynthesisFailedError,
  type ModelRequest,
  type ModelResult,
  type ModelRunner,
  type ModelUsage,
} from './model-runner';
import { SynthesisOutputSchema } from './output.schema';

export interface AnthropicModelRunnerOptions {
  apiKey: string;
  model: string;
  effort: 'low' | 'medium' | 'high';
  /** Model turns, each followed by the tool calls it asked for. */
  maxIterations?: number;
  maxTokens?: number;
  /** Injected in tests; built from `apiKey` otherwise. */
  client?: Anthropic;
}

const DEFAULT_MAX_ITERATIONS = 6;
const DEFAULT_MAX_TOKENS = 16_000;

function addUsage(total: ModelUsage, m: BetaMessage): void {
  total.inputTokens += m.usage.input_tokens;
  total.outputTokens += m.usage.output_tokens;
  total.cacheReadTokens += m.usage.cache_read_input_tokens ?? 0;
  total.cacheWriteTokens += m.usage.cache_creation_input_tokens ?? 0;
}

/** The one place that talks to the Anthropic API: a bounded, streaming tool loop. */
export class AnthropicModelRunner implements ModelRunner {
  private readonly client: Anthropic;

  constructor(private readonly opts: AnthropicModelRunnerOptions) {
    this.client =
      opts.client ??
      new Anthropic({ apiKey: opts.apiKey, maxRetries: 2, timeout: 120_000 });
  }

  async run(req: ModelRequest): Promise<ModelResult> {
    const runner = this.client.beta.messages.toolRunner({
      model: this.opts.model,
      max_tokens: this.opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      // The static system prompt (after the static tools) is the cross-request
      // cache prefix; the top-level marker caches the growing conversation
      // between turns of one loop.
      system: [
        {
          type: 'text',
          text: req.system,
          cache_control: { type: 'ephemeral' },
        },
      ],
      cache_control: { type: 'ephemeral' },
      messages: [{ role: 'user', content: req.user }],
      tools: req.tools,
      output_config: {
        effort: this.opts.effort,
        format: betaZodOutputFormat(SynthesisOutputSchema),
      },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      max_iterations: this.opts.maxIterations ?? DEFAULT_MAX_ITERATIONS,
      thread: false,
      stream: true,
    });

    const usage: ModelUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    let toolCalls = 0;
    let turns = 0;
    for await (const stream of runner) {
      const message = await stream.finalMessage();
      turns += 1;
      addUsage(usage, message);
      toolCalls += message.content.filter((b) => b.type === 'tool_use').length;
    }
    const final = await runner.done();

    switch (final.stop_reason) {
      case 'refusal':
        throw new SynthesisFailedError('refusal');
      case 'max_tokens':
      case 'model_context_window_exceeded':
        throw new SynthesisFailedError('max_tokens');
      case 'tool_use':
        throw new SynthesisFailedError('max_iterations');
    }

    return {
      output: parseOutput(final),
      usage,
      toolCalls,
      turns,
      model: final.model,
      stopReason: final.stop_reason ?? 'unknown',
    };
  }
}

/** The SDK's parsed output when it has one, else the final text as JSON. */
function parseOutput(final: BetaMessage): unknown {
  const parsed = (final as { parsed_output?: unknown }).parsed_output;
  if (parsed !== undefined && parsed !== null) return parsed;
  const text = final.content
    .flatMap((b) => (b.type === 'text' ? [b.text] : []))
    .join('');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SynthesisFailedError('unparseable', 'final text is not JSON');
  }
}
