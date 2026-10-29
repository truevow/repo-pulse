import { loadEnv } from '../config/env';
import { AnthropicModelRunner } from './anthropic-model.runner';
import { NotConfiguredModelRunner } from './model-runner';
import { createModelRunner } from './synthesis.module';

const env = (key?: string) =>
  loadEnv({
    DATABASE_URL: 'postgresql://unused',
    ...(key !== undefined && { ANTHROPIC_API_KEY: key }),
  });

describe('createModelRunner', () => {
  it('builds the Anthropic runner when an API key is set', () => {
    expect(createModelRunner(env('test-key'))).toBeInstanceOf(
      AnthropicModelRunner,
    );
  });

  it('builds the not-configured runner without a key (or with an empty one)', async () => {
    for (const runner of [
      createModelRunner(env()),
      createModelRunner(env('')),
    ]) {
      expect(runner).toBeInstanceOf(NotConfiguredModelRunner);
      await expect(
        runner.run({ system: '', user: '', tools: [] }),
      ).rejects.toMatchObject({
        problem: { status: 503, type: 'llm-not-configured' },
      });
    }
  });
});
