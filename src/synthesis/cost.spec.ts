import { costUsd } from './cost';

describe('costUsd', () => {
  it('prices the smoke-test row at $4/$20/$0.20/$5 per MTok', () => {
    expect(
      costUsd({
        inputTokens: 6,
        outputTokens: 1731,
        cacheReadTokens: 7110,
        cacheWriteTokens: 8468,
      }),
    ).toBe(0.078406);
  });

  it('prices each token class separately', () => {
    const one = (k: string) =>
      costUsd({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        [k]: 1_000_000,
      });
    expect(one('inputTokens')).toBe(4);
    expect(one('outputTokens')).toBe(20);
    expect(one('cacheReadTokens')).toBe(0.2);
    expect(one('cacheWriteTokens')).toBe(5);
  });
});
