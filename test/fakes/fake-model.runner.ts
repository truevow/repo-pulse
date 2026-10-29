import type {
  ModelRequest,
  ModelResult,
  ModelRunner,
} from '../../src/synthesis/model-runner';

/**
 * Scripted ModelRunner: each `run` records the request and consumes the next
 * response (an `Error` element is thrown). With `delayMs` it resolves late, so
 * two concurrent requests overlap.
 */
export class FakeModelRunner implements ModelRunner {
  readonly calls: ModelRequest[] = [];

  constructor(
    private responses: Array<unknown | Error> = [],
    private readonly opts: { delayMs?: number } = {},
  ) {}

  /** Replaces the script and clears recorded calls. */
  reset(responses: Array<unknown | Error>): void {
    this.responses = [...responses];
    this.calls.length = 0;
  }

  async run(req: ModelRequest): Promise<ModelResult> {
    this.calls.push(req);
    if (this.responses.length === 0) {
      throw new Error('FakeModelRunner: no scripted response left');
    }
    const next = this.responses.shift();
    if (this.opts.delayMs) {
      await new Promise((r) => setTimeout(r, this.opts.delayMs));
    }
    if (next instanceof Error) throw next;
    return {
      output: next,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      toolCalls: 0,
      turns: 1,
      model: 'fake',
      stopReason: 'end_turn',
    };
  }
}
