import type { Repository, SyncJob } from '@prisma/client';
import { z } from 'zod';

/** GitHub owner/repo names; also keeps path segments out of upstream queries. */
export const NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;
const NAME = z.string().regex(NAME_PATTERN, 'must be a valid GitHub name');
const ISO_DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date (YYYY-MM-DD)');

export const RepoParamsSchema = z.object({ owner: NAME, repo: NAME });
export type RepoParams = z.infer<typeof RepoParamsSchema>;

/** Both bounds optional; a missing body is treated as `{}`. */
export const SyncBodySchema = z.preprocess(
  (v) => v ?? {},
  z.object({ from: ISO_DATE.optional(), to: ISO_DATE.optional() }),
);
export type SyncBody = z.infer<typeof SyncBodySchema>;

export const SyncJobParamsSchema = z.object({ id: z.uuid() });
export type SyncJobParams = z.infer<typeof SyncJobParamsSchema>;

export type SyncJobWithRepository = SyncJob & {
  repository: Pick<Repository, 'owner' | 'name'>;
};

export interface SyncJobResponse {
  id: string;
  repository: { owner: string; name: string };
  status: SyncJob['status'];
  mode: SyncJob['mode'];
  window: { from: string; to: string };
  counts: {
    pullRequests: number;
    reviews: number;
    issues: number;
    commits: number;
  };
  rateLimitRemaining: number | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

const isoOrNull = (d: Date | null): string | null => d?.toISOString() ?? null;

export function toSyncJobResponse(job: SyncJobWithRepository): SyncJobResponse {
  return {
    id: job.id,
    repository: { owner: job.repository.owner, name: job.repository.name },
    status: job.status,
    mode: job.mode,
    window: {
      from: job.requestedFrom.toISOString(),
      to: job.requestedTo.toISOString(),
    },
    counts: {
      pullRequests: job.pullRequests,
      reviews: job.reviews,
      issues: job.issues,
      commits: job.commits,
    },
    rateLimitRemaining: job.rateLimitRemaining,
    error: job.error,
    createdAt: job.createdAt.toISOString(),
    startedAt: isoOrNull(job.startedAt),
    finishedAt: isoOrNull(job.finishedAt),
  };
}
