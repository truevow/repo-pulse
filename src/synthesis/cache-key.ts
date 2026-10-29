import { createHash } from 'node:crypto';
import type { BucketSize } from '../signals/buckets';
import type { Signal } from '../signals/signal.types';

export interface CacheKeyParts {
  owner: string;
  repo: string;
  /** Resolved window bounds (ISO timestamps), not the raw query. */
  from: string;
  to: string;
  bucket: BucketSize;
  includeBots: boolean;
  signalsFingerprint: string;
  promptVersion: string;
  model: string;
  effort: string;
}

const sha256 = (s: string): string =>
  createHash('sha256').update(s).digest('hex');

/** One narrative per distinct input: any part changing yields a new key. */
export function narrativeCacheKey(p: CacheKeyParts): string {
  // A fixed-order array, JSON-encoded, so no part can bleed into the next.
  return sha256(
    JSON.stringify([
      p.owner.toLowerCase(),
      p.repo.toLowerCase(),
      p.from,
      p.to,
      p.bucket,
      p.includeBots,
      p.signalsFingerprint,
      p.promptVersion,
      p.model,
      p.effort,
    ]),
  );
}

/** Order-independent digest of what the detectors found. */
export function signalsFingerprint(signals: Signal[]): string {
  return sha256(
    signals
      .map((s) => `${s.id}:${s.observed}`)
      .sort()
      .join(','),
  );
}
