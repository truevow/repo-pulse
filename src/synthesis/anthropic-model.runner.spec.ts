import type Anthropic from '@anthropic-ai/sdk';
import { AnthropicModelRunner } from './anthropic-model.runner';
import { SynthesisFailedError } from './model-runner';

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown };

interface FakeMessage {
  model: string;
  stop_reason: string;
  content: Block[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number | null;
    cache_creation_input_tokens: number | null;
  };
}

const msg = (
  stop_reason: string,
  content: Block[],
  model = 'claude-opus-5-5',
): FakeMessage => ({
  model,
  stop_reason,
  content,
  usage: {
    input_tokens: 100,
    output_tokens: 10,
    cache_read_input_tokens: 50,
    cache_creation_input_tokens: null,
  },
});

const toolUse = (id: string): Block => ({
  type: 'tool_use',
  id,
  name: 'get_metric_series',
  input: { metric: 'commits' },
});

const OUTPUT = {
  headline: 'h',
  narrative: 'n',
  hypotheses: [],
  data_caveats: [],
};

/** A client whose tool runner yields one stream per scripted turn. */
function fakeClient(turns: FakeMessage[]) {
  const toolRunner = jest.fn(() => ({
    async *[Symbol.asyncIterator]() {
      for (const m of turns) yield { finalMessage: () => Promise.resolve(m) };
    },
    done: () => Promise.resolve(turns[turns.length - 1]),
  }));
  const client = { beta: { messages: { toolRunner } } } as unknown as Anthropic;
  return { client, toolRunner };
}

const runner = (client: Anthropic) =>
  new AnthropicModelRunner({
    apiKey: 'unused',
    model: 'claude-opus-5-5',
    effort: 'medium',
    client,
  });

const REQ = { system: 'sys', user: 'usr', tools: [] };

describe('AnthropicModelRunner', () => {
  it('sums usage over turns, counts tool calls and parses the final JSON text', async () => {
    const { client, toolRunner } = fakeClient([
      msg('tool_use', [toolUse('a'), toolUse('b')]),
      msg(
        'end_turn',
        [{ type: 'text', text: JSON.stringify(OUTPUT) }],
        'claude-opus-5',
      ),
    ]);

    const r = await runner(client).run(REQ);

    expect(r).toEqual({
      output: OUTPUT,
      usage: {
        inputTokens: 200,
        outputTokens: 20,
        cacheReadTokens: 100,
        cacheWriteTokens: 0,
      },
      toolCalls: 2,
      turns: 2,
      model: 'claude-opus-5',
      stopReason: 'end_turn',
    });
    const params = (toolRunner.mock.calls[0] as unknown[])[0] as Record<
      string,
      unknown
    >;
    expect(params).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      system: [
        { type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: 'usr' }],
      output_config: { effort: 'medium' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      max_iterations: 6,
      thread: false,
      stream: true,
    });
    expect(params).not.toHaveProperty('thinking');
    expect(params).not.toHaveProperty('tool_choice');
    expect(
      (params.output_config as { format?: { type: string } }).format?.type,
    ).toBe('json_schema');
  });

  it.each([
    ['refusal', 'refusal'],
    ['max_tokens', 'max_tokens'],
    ['tool_use', 'max_iterations'],
  ])('maps a final stop_reason %s to %s', async (stop, reason) => {
    const { client } = fakeClient([msg(stop, [toolUse('a')])]);
    const err = await runner(client)
      .run(REQ)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SynthesisFailedError);
    expect((err as SynthesisFailedError).reason).toBe(reason);
  });

  it('fails unparseable when the final text is not JSON', async () => {
    const { client } = fakeClient([
      msg('end_turn', [{ type: 'text', text: 'Here is my analysis' }]),
    ]);
    await expect(runner(client).run(REQ)).rejects.toMatchObject({
      reason: 'unparseable',
    });
  });
});
