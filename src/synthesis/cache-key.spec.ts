import type { Signal } from '../signals/signal.types';
import {
  narrativeCacheKey,
  signalsFingerprint,
  type CacheKeyParts,
} from './cache-key';

const BASE: CacheKeyParts = {
  owner: 'acme',
  repo: 'metrics',
  from: '2026-09-07T00:00:00.000Z',
  to: '2026-10-19T00:00:00.000Z',
  bucket: 'week',
  includeBots: false,
  signalsFingerprint: 'abc',
  promptVersion: 'v1',
  model: 'claude-opus-5-5',
  effort: 'medium',
};

const VARIANTS: { [K in keyof CacheKeyParts]: CacheKeyParts[K] } = {
  owner: 'other',
  repo: 'other',
  from: '2026-09-14T00:00:00.000Z',
  to: '2026-10-26T00:00:00.000Z',
  bucket: 'day',
  includeBots: true,
  signalsFingerprint: 'def',
  promptVersion: 'v2',
  model: 'claude-sonnet-5-5',
  effort: 'high',
};

const signal = (id: string, observed: number): Signal =>
  ({ id, observed }) as Signal;

describe('narrativeCacheKey', () => {
  it('is a stable sha256 hex digest', () => {
    const key = narrativeCacheKey(BASE);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(narrativeCacheKey({ ...BASE })).toBe(key);
  });

  it.each(Object.keys(VARIANTS) as Array<keyof CacheKeyParts>)(
    'changes when %s changes',
    (part) => {
      expect(narrativeCacheKey({ ...BASE, [part]: VARIANTS[part] })).not.toBe(
        narrativeCacheKey(BASE),
      );
    },
  );

  it('does not let one part bleed into the next', () => {
    expect(
      narrativeCacheKey({ ...BASE, owner: 'ac', repo: 'memetrics' }),
    ).not.toBe(narrativeCacheKey({ ...BASE, owner: 'acme', repo: 'metrics' }));
  });
});

describe('signalsFingerprint', () => {
  it('is order-independent', () => {
    const a = [signal('s1', 190), signal('s2', 4)];
    expect(signalsFingerprint(a)).toBe(signalsFingerprint([...a].reverse()));
  });

  it('changes with an id or an observed value', () => {
    const base = signalsFingerprint([signal('s1', 190)]);
    expect(signalsFingerprint([signal('s2', 190)])).not.toBe(base);
    expect(signalsFingerprint([signal('s1', 191)])).not.toBe(base);
    expect(signalsFingerprint([])).not.toBe(base);
  });

  it('is a sha256 hex digest of the sorted id:observed list', () => {
    expect(signalsFingerprint([])).toMatch(/^[0-9a-f]{64}$/);
  });
});
