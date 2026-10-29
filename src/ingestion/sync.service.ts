import { Inject, Injectable } from '@nestjs/common';
import type { SyncMode } from '@prisma/client';
import { ProblemException } from '../common/problem.exception';
import { GITHUB_CLIENT, type GitHubClient } from '../github/github.client';
import { GitHubError } from '../github/github.errors';
import type { RepositoryResult } from '../github/github.types';
import { REPOSITORY_QUERY } from '../github/queries';
import { PrismaService } from '../prisma/prisma.service';
import type { Window } from '../signals/buckets';
import { NAME_PATTERN, type SyncJobWithRepository } from './dto';
import { SyncRunner } from './sync-runner';

const WITH_REPOSITORY = {
  repository: { select: { owner: true, name: true } },
} as const;

function githubProblem(err: GitHubError): ProblemException {
  switch (err.kind) {
    case 'not_found':
      return repoNotFound();
    case 'token_missing':
      return new ProblemException({
        status: 503,
        type: 'github-token-missing',
        title: 'GitHub token missing',
        detail: 'Set GITHUB_TOKEN to enable syncing from GitHub',
      });
    default:
      return new ProblemException({
        status: 503,
        type: 'github-unavailable',
        title: 'GitHub unavailable',
        detail: err.kind,
      });
  }
}

function repoNotFound(): ProblemException {
  return new ProblemException({
    status: 404,
    type: 'github-repo-not-found',
    title: 'Repository not found',
    detail: 'GitHub has no such repository, or the token cannot see it',
  });
}

@Injectable()
export class SyncService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(GITHUB_CLIENT) private readonly github: GitHubClient,
    private readonly runner: SyncRunner,
  ) {}

  /** Starts a sync for the window, or returns the repo's queued/running job. */
  async startSync(
    owner: string,
    repo: string,
    window: Window,
  ): Promise<{ job: SyncJobWithRepository; created: boolean }> {
    if (!NAME_PATTERN.test(owner) || !NAME_PATTERN.test(repo)) {
      throw new ProblemException({
        status: 400,
        type: 'validation-error',
        title: 'Bad Request',
        detail: 'owner and repo must be valid GitHub names',
      });
    }
    const meta = await this.fetchRepository(owner, repo);
    const [canonicalOwner, canonicalName] = meta.nameWithOwner.split('/');
    const metadata = {
      owner: canonicalOwner,
      name: canonicalName,
      defaultBranch: meta.defaultBranchRef?.name ?? '',
      hasIssuesEnabled: meta.hasIssuesEnabled,
      hasPullRequests: meta.pullRequests.totalCount > 0,
    };

    const result = await this.prisma.$transaction(async (tx) => {
      // The upsert's UPDATE row-locks an existing repository, so concurrent
      // requests for it serialise on the active-job check below.
      const repository = await tx.repository.upsert({
        where: { githubId: meta.id },
        create: { githubId: meta.id, ...metadata },
        update: metadata,
      });
      const active = await tx.syncJob.findFirst({
        where: {
          repositoryId: repository.id,
          status: { in: ['queued', 'running'] },
        },
        orderBy: { createdAt: 'desc' },
        include: WITH_REPOSITORY,
      });
      if (active) return { job: active, created: false };

      let mode: SyncMode = 'incremental';
      if (!repository.coveredFrom) mode = 'initial';
      else if (window.from < repository.coveredFrom) mode = 'backfill';
      const job = await tx.syncJob.create({
        data: {
          repositoryId: repository.id,
          mode,
          requestedFrom: window.from,
          requestedTo: window.to,
        },
        include: WITH_REPOSITORY,
      });
      return { job, created: true };
    });

    if (result.created) this.runner.enqueue(result.job.id);
    return result;
  }

  getJob(id: string): Promise<SyncJobWithRepository | null> {
    return this.prisma.syncJob.findUnique({
      where: { id },
      include: WITH_REPOSITORY,
    });
  }

  private async fetchRepository(
    owner: string,
    name: string,
  ): Promise<NonNullable<RepositoryResult['repository']>> {
    let result: RepositoryResult;
    try {
      result = await this.github.query<RepositoryResult>(REPOSITORY_QUERY, {
        owner,
        name,
      });
    } catch (err) {
      if (err instanceof GitHubError) throw githubProblem(err);
      throw err;
    }
    if (!result.repository) throw repoNotFound();
    return result.repository;
  }
}
