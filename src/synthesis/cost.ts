import type { ModelUsage } from './model-runner';

/** USD per million tokens, Claude Opus 5.5 list prices (an estimate under fallback). */
export const PRICE_PER_MTOK = {
  input: 4,
  output: 20,
  cacheRead: 0.2,
  cacheWrite: 5,
} as const;

/** Estimated request cost in USD, rounded to six decimals. */
export function costUsd(u: ModelUsage): number {
  const dollars =
    (u.inputTokens * PRICE_PER_MTOK.input +
      u.outputTokens * PRICE_PER_MTOK.output +
      u.cacheReadTokens * PRICE_PER_MTOK.cacheRead +
      u.cacheWriteTokens * PRICE_PER_MTOK.cacheWrite) /
    1_000_000;
  return Math.round(dollars * 1e6) / 1e6;
}
