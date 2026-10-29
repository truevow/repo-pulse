import Anthropic from '@anthropic-ai/sdk';
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

  it('maps a non-API SDK error to unparseable without its message, and passes API errors through', async () => {
    const throwing = (err: Error): Anthropic =>
      ({
        beta: {
          messages: {
            toolRunner: () => ({
              // eslint-disable-next-line require-yield
              async *[Symbol.asyncIterator]() {
                throw err;
              },
              done: () => Promise.reject(err),
            }),
          },
        },
      }) as unknown as Anthropic;

    const parseErr = await runner(
      throwing(new Anthropic.AnthropicError('Failed to parse: model secret')),
    )
      .run(REQ)
      .catch((e: unknown) => e);
    expect(parseErr).toBeInstanceOf(SynthesisFailedError);
    expect((parseErr as SynthesisFailedError).reason).toBe('unparseable');
    expect((parseErr as Error).message).not.toContain('secret');

    const limited = new Anthropic.RateLimitError(
      429,
      { message: 'x' },
      'x',
      new Headers(),
    );
    await expect(runner(throwing(limited)).run(REQ)).rejects.toBe(limited);
  });

  describe('against the real SDK stream parser (scripted SSE)', () => {
    /** One streamed turn: a single text block, then the given stop reason. */
    function sse(stop: string, text: string): string {
      const events: Array<[string, unknown]> = [
        [
          'message_start',
          {
            type: 'message_start',
            message: {
              id: 'msg_1',
              type: 'message',
              role: 'assistant',
              model: 'claude-opus-5-5',
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 7, output_tokens: 0 },
            },
          },
        ],
        [
          'content_block_start',
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          },
        ],
        [
          'content_block_delta',
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text },
          },
        ],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        [
          'message_delta',
          {
            type: 'message_delta',
            delta: { stop_reason: stop, stop_sequence: null },
            usage: { output_tokens: 5 },
          },
        ],
        ['message_stop', { type: 'message_stop' }],
      ];
      return events
        .map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`)
        .join('');
    }

    const sdkClient = (stop: string, text: string): Anthropic =>
      new Anthropic({
        apiKey: 'test-key',
        baseURL: 'http://localhost:1',
        maxRetries: 0,
        fetch: () =>
          Promise.resolve(
            new Response(sse(stop, text), {
              headers: { 'content-type': 'text/event-stream' },
            }),
          ),
      });

    it.each([
      ['max_tokens', '{"headline": "trunc', 'max_tokens'],
      ['refusal', 'I cannot help with that.', 'refusal'],
      ['end_turn', 'Here is my analysis, not JSON', 'unparseable'],
    ])(
      'stop_reason %s with text %j fails as %s without quoting the text',
      async (stop, text, reason) => {
        const err = await runner(sdkClient(stop, text))
          .run(REQ)
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SynthesisFailedError);
        expect((err as SynthesisFailedError).reason).toBe(reason);
        expect((err as Error).message).not.toContain(text);
      },
    );

    it('passes a schema-invalid but well-formed JSON answer through for the service to reject', async () => {
      const r = await runner(sdkClient('end_turn', '{"headline": 5}')).run(REQ);
      expect(r.output).toEqual({ headline: 5 });
    });

    it('parses a valid answer and reports usage, model and stop reason', async () => {
      const r = await runner(sdkClient('end_turn', JSON.stringify(OUTPUT))).run(
        REQ,
      );
      expect(r).toEqual({
        output: OUTPUT,
        usage: {
          inputTokens: 7,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        toolCalls: 0,
        turns: 1,
        model: 'claude-opus-5-5',
        stopReason: 'end_turn',
      });
    });
  });
});
