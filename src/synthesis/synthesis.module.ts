import { Module } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { SignalsModule } from '../signals/signals.module';
import { AnthropicModelRunner } from './anthropic-model.runner';
import {
  MODEL_RUNNER,
  NotConfiguredModelRunner,
  type ModelRunner,
} from './model-runner';
import { NarrativeController } from './narrative.controller';
import { NarrativeService } from './narrative.service';

/** The real runner when an API key is configured, otherwise a 503 stand-in. */
export function createModelRunner(env: Env): ModelRunner {
  return env.ANTHROPIC_API_KEY
    ? new AnthropicModelRunner({
        apiKey: env.ANTHROPIC_API_KEY,
        model: env.ANTHROPIC_MODEL,
        effort: env.ANTHROPIC_EFFORT,
      })
    : new NotConfiguredModelRunner();
}

@Module({
  imports: [SignalsModule],
  controllers: [NarrativeController],
  providers: [
    { provide: MODEL_RUNNER, inject: [ENV], useFactory: createModelRunner },
    NarrativeService,
  ],
})
export class SynthesisModule {}
