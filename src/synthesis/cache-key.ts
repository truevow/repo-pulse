import { createHash } from 'node:crypto';
import type { BucketSize } from '../signals/buckets';
import type { InsightsResponse } from '../signals/insights.types';
import type { Signal } from '../signals/signal.types';
import { buildUserMessage } from './prompts/user-message';

export interface CacheKeyParts {
  owner: string;
  repo: string;
  /** Resolved window bounds (ISO timestamps), not the raw query. */
  from: string;
  to: string;
  bucket: BucketSize;
  includeBots: boolean;
  signalsFingerprint: string;
  /** Digest of the user message: every number and label the model is shown. */
  dataFingerprint: string;
  /** Last sync start: tool-visible data (examples, activity) may change with it. */
  lastSyncedAt: string | null;
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
      p.dataFingerprint,
      p.lastSyncedAt,
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

/** Digest of everything the model is shown up front (the user message). */
export function dataFingerprint(insights: InsightsResponse): string {
  return sha256(buildUserMessage(insights));
}
