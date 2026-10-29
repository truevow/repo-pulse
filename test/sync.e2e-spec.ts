import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  GITHUB_CLIENT,
  MissingTokenGitHubClient,
  type GitHubClient,
} from '../src/github/github.client';
import { GitHubError } from '../src/github/github.errors';
import {
  COMMITS_QUERY,
  ISSUES_QUERY,
  PULL_REQUEST_REVIEWS_QUERY,
  PULL_REQUESTS_QUERY,
  REPOSITORY_QUERY,
} from '../src/github/queries';
import { SyncRunner } from '../src/ingestion/sync-runner';
import { PrismaService } from '../src/prisma/prisma.service';
import { FakeGitHubClient } from './fakes/fake-github.client';
import {
  COMMITS,
  FINAL_RATE_LIMIT_REMAINING,
  LATE_COMMIT,
  NAME,
  OWNER,
  PR_PAGE_1,
  REVIEW_OVERFLOW_CURSOR,
  WINDOW,
  commitsResult,
  repositoryResult,
  smallRepoResponses,
} from './fixtures/github/small-repo';
import { inspect } from 'node:util';
import { PinoLogger } from 'nestjs-pino';
import { defaultWindow } from '../src/signals/buckets';
import { createTestApp, resetDatabase } from './setup/db';

const PROBLEM = 'https://repo-pulse.local/problems/';
const ALL_COUNTS = { pullRequests: 3, reviews: 4, issues: 2, commits: 2 };
const iso = (date: string) => `${date}T00:00:00.000Z`;

/** Lets each test swap the GitHub client behind the app's GITHUB_CLIENT. */
class SwitchableGitHubClient implements GitHubClient {
  current: GitHubClient = new MissingTokenGitHubClient();
  query<T>(document: string, variables: Record<string, unknown>): Promise<T> {
    return this.current.query<T>(document, variables);
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('Sync (e2e)', () => {
  const client = new SwitchableGitHubClient();
  let app: INestApplication;
  let prisma: PrismaService;
  let runner: SyncRunner;
  let fake: FakeGitHubClient;

  const use = (next: GitHubClient) => (client.current = next);
  const sync = (body?: object, owner = OWNER, repo = NAME) => {
    const req = request(app.getHttpServer()).post(
      `/api/v1/repos/${owner}/${repo}/sync`,
    );
    return body === undefined ? req : req.send(body);
  };
  const getJob = async (id: string) =>
    (
      await request(app.getHttpServer())
        .get(`/api/v1/sync-jobs/${id}`)
        .expect(200)
    ).body;
  const repository = () =>
    prisma.repository.findUniqueOrThrow({
      where: { owner_name: { owner: OWNER, name: NAME } },
    });

  beforeAll(async () => {
    app = await createTestApp([{ provide: GITHUB_CLIENT, useValue: client }]);
    prisma = app.get(PrismaService);
    runner = app.get(SyncRunner);
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    fake = new FakeGitHubClient(smallRepoResponses());
    use(fake);
  });

  afterEach(async () => {
    await runner.whenIdle();
  });

  afterAll(async () => {
    await app.close();
  });

  it('runs an initial sync: 202 + Location, then succeeded with counts and coverage', async () => {
    const res = await sync(WINDOW).expect(202);
    const id: string = res.body.id;
    expect(res.headers.location).toBe(`/api/v1/sync-jobs/${id}`);
    expect(res.body).toMatchObject({
      status: 'queued',
      mode: 'initial',
      repository: { owner: OWNER, name: NAME },
      window: { from: iso(WINDOW.from), to: iso(WINDOW.to) },
    });

    await runner.whenIdle();
    const job = await getJob(id);
    expect(job).toMatchObject({
      id,
      status: 'succeeded',
      mode: 'initial',
      counts: ALL_COUNTS,
      rateLimitRemaining: FINAL_RATE_LIMIT_REMAINING,
      error: null,
    });
    expect(Date.parse(job.startedAt)).not.toBeNaN();
    expect(Date.parse(job.finishedAt)).toBeGreaterThanOrEqual(
      Date.parse(job.startedAt),
    );

    const repo = await repository();
    expect(repo.coveredFrom).toEqual(new Date(iso(WINDOW.from)));
    expect(repo.coveredTo).toEqual(new Date(iso(WINDOW.to)));
    expect(repo.lastSyncedAt?.toISOString()).toBe(job.startedAt);
    expect(repo).toMatchObject({
      githubId: 'R_kgDOwidgets',
      defaultBranch: 'main',
      hasIssuesEnabled: true,
      hasPullRequests: true,
    });

    expect(await prisma.pullRequest.count()).toBe(3);
    expect(await prisma.review.count()).toBe(4);
    expect(await prisma.issue.count()).toBe(2);
    expect(await prisma.commit.count()).toBe(2);
    expect(fake.callsTo(PULL_REQUESTS_QUERY)).toHaveLength(2);
    expect(fake.callsTo(PULL_REQUEST_REVIEWS_QUERY)).toEqual([
      { id: 'PR_3', cursor: REVIEW_OVERFLOW_CURSOR },
    ]);
    expect(fake.callsTo(COMMITS_QUERY)).toEqual([
      {
        owner: OWNER,
        name: NAME,
        since: iso(WINDOW.from),
        until: iso(WINDOW.to),
        cursor: null,
      },
    ]);
  });

  it('runs a backfill for an earlier from, then an incremental sync for the same window', async () => {
    await sync(WINDOW).expect(202);
    await runner.whenIdle();

    const wider = { from: '2026-08-03', to: WINDOW.to };
    const backfill = await sync(wider).expect(202);
    expect(backfill.body.mode).toBe('backfill');
    await runner.whenIdle();
    const backfillJob = await getJob(backfill.body.id);
    expect(backfillJob).toMatchObject({
      status: 'succeeded',
      counts: ALL_COUNTS,
    });
    let repo = await repository();
    expect(repo.coveredFrom).toEqual(new Date(iso(wider.from)));
    expect(repo.coveredTo).toEqual(new Date(iso(WINDOW.to)));
    expect(repo.lastSyncedAt?.toISOString()).toBe(backfillJob.startedAt);

    const callsBefore = fake.calls.length;
    const incremental = await sync(wider).expect(202);
    expect(incremental.body.mode).toBe('incremental');
    await runner.whenIdle();
    const incrementalJob = await getJob(incremental.body.id);
    // Everything was updated before the high-water mark: the first page's
    // last PR is older than `since`, so paging stops after one page.
    expect(incrementalJob).toMatchObject({
      status: 'succeeded',
      counts: { pullRequests: 0, reviews: 0, issues: 0, commits: 0 },
    });
    const calls = fake.calls.slice(callsBefore);
    expect(
      calls.filter((c) => c.document === PULL_REQUESTS_QUERY),
    ).toHaveLength(1);
    expect(
      calls.find((c) => c.document === COMMITS_QUERY)?.variables,
    ).toMatchObject({ since: iso(WINDOW.to), until: iso(WINDOW.to) });
    repo = await repository();
    expect(repo.coveredFrom).toEqual(new Date(iso(wider.from)));
    expect(repo.lastSyncedAt?.toISOString()).toBe(incrementalJob.startedAt);
    expect(await prisma.pullRequest.count()).toBe(3);
  });

  it('fetches commits up to the old coverage start for a disjoint earlier backfill', async () => {
    await sync(WINDOW).expect(202);
    await runner.whenIdle();

    // Ends before the synced range starts: coverage will be extended across
    // the gap [earlier.to, WINDOW.from), so its commits must be fetched too.
    const earlier = { from: '2026-07-06', to: '2026-08-03' };
    const backfill = await sync(earlier).expect(202);
    expect(backfill.body.mode).toBe('backfill');
    await runner.whenIdle();
    expect((await getJob(backfill.body.id)).status).toBe('succeeded');

    expect(fake.callsTo(COMMITS_QUERY).at(-1)).toMatchObject({
      since: iso(earlier.from),
      until: iso(WINDOW.from),
    });
    const repo = await repository();
    expect(repo.coveredFrom).toEqual(new Date(iso(earlier.from)));
    expect(repo.coveredTo).toEqual(new Date(iso(WINDOW.to)));
  });

  it('returns the running job with 200 when a sync is already in progress', async () => {
    const release = fake.hold(PULL_REQUESTS_QUERY);
    let first: request.Response;
    try {
      first = await sync(WINDOW).expect(202);
      await waitFor(() => fake.callsTo(PULL_REQUESTS_QUERY).length === 1);
      expect((await getJob(first.body.id)).status).toBe('running');

      const second = await sync({ from: '2026-08-03', to: WINDOW.to }).expect(
        200,
      );
      expect(second.body.id).toBe(first.body.id);
      expect(second.body.status).toBe('running');
      expect(second.headers.location).toBeUndefined();
      expect(await prisma.syncJob.count()).toBe(1);
    } finally {
      // Always release, or the held job would keep the runner busy forever.
      release();
    }
    await runner.whenIdle();
    expect(await getJob(first.body.id)).toMatchObject({
      status: 'succeeded',
      counts: ALL_COUNTS,
    });
  });

  it('uses the default window for an empty body', async () => {
    const expected = defaultWindow(new Date());
    const res = await sync().expect(202);
    expect(res.body.window).toEqual({
      from: expected.from.toISOString(),
      to: expected.to.toISOString(),
    });
    await runner.whenIdle();
    expect((await getJob(res.body.id)).status).toBe('succeeded');
  });

  it("starts an incremental job's commit query at the previous coverage end", async () => {
    fake = new FakeGitHubClient({
      ...smallRepoResponses(),
      [COMMITS_QUERY]: (vars) => commitsResult(vars, [...COMMITS, LATE_COMMIT]),
    });
    use(fake);
    const a = await sync(WINDOW).expect(202);
    await runner.whenIdle();
    const jobA = await getJob(a.body.id);
    expect(jobA.counts.commits).toBe(2);
    const coveredToA = (await repository()).coveredTo!.toISOString();
    expect(coveredToA).toBe(iso(WINDOW.to));
    // LATE_COMMIT is dated between A.to and A.startedAt.
    expect(Date.parse(LATE_COMMIT.committedDate)).toBeLessThan(
      Date.parse(jobA.startedAt),
    );

    const windowB = { from: WINDOW.from, to: '2026-10-28' };
    const b = await sync(windowB).expect(202);
    expect(b.body.mode).toBe('incremental');
    await runner.whenIdle();
    const jobB = await getJob(b.body.id);
    expect(jobB).toMatchObject({ status: 'succeeded', counts: { commits: 1 } });

    expect(fake.callsTo(COMMITS_QUERY).at(-1)).toMatchObject({
      since: coveredToA,
      until: iso(windowB.to),
    });
    expect(
      await prisma.commit.findFirst({ where: { sha: LATE_COMMIT.oid } }),
    ).not.toBeNull();
    expect((await repository()).coveredTo).toEqual(new Date(iso(windowB.to)));
  });

  it.each([
    [
      'GitHub reports NOT_FOUND',
      [new GitHubError('not_found', 'Could not resolve')],
    ],
    ['the repository is null', [{ ...repositoryResult(), repository: null }]],
  ])('returns 404 github-repo-not-found when %s', async (_name, responses) => {
    use(new FakeGitHubClient({ [REPOSITORY_QUERY]: responses }));
    const res = await sync(WINDOW).expect(404);
    expect(res.body).toMatchObject({
      type: `${PROBLEM}github-repo-not-found`,
      status: 404,
    });
    expect(await prisma.repository.count()).toBe(0);
    expect(await prisma.syncJob.count()).toBe(0);
  });

  it('returns 503 github-token-missing without a token', async () => {
    use(new MissingTokenGitHubClient());
    const res = await sync(WINDOW).expect(503);
    expect(res.body.type).toBe(`${PROBLEM}github-token-missing`);
    expect(res.body.detail).toMatch(/GITHUB_TOKEN/);
  });

  it.each(['unauthorized', 'forbidden', 'unavailable', 'bad_query'] as const)(
    'returns 503 github-unavailable for %s without the raw message',
    async (kind) => {
      use(
        new FakeGitHubClient({
          [REPOSITORY_QUERY]: [
            new GitHubError(kind, 'raw upstream secret-xyz'),
          ],
        }),
      );
      const res = await sync(WINDOW).expect(503);
      expect(res.body).toMatchObject({
        type: `${PROBLEM}github-unavailable`,
        detail: kind,
      });
      expect(JSON.stringify(res.body)).not.toContain('secret-xyz');
    },
  );

  it.each([
    ['owner is a path traversal', () => sync(WINDOW, '..%2Fx')],
    ['repo has an invalid character', () => sync(WINDOW, OWNER, 'wid$gets')],
    ['from is after to', () => sync({ from: WINDOW.to, to: WINDOW.from })],
    [
      'the window is 30 weeks',
      () => sync({ from: '2026-03-30', to: WINDOW.to }),
    ],
    ['from is not a date', () => sync({ from: '2026-13-01' })],
    ['to is in the future', () => sync({ to: '2099-01-05' })],
  ])('returns 400 when %s and never calls GitHub', async (_name, send) => {
    const res = await send().expect(400);
    expect(res.body.type).toBe(`${PROBLEM}validation-error`);
    expect(fake.calls).toHaveLength(0);
  });

  it('syncs a repo with issues disabled and no PRs without querying them', async () => {
    fake = new FakeGitHubClient(
      smallRepoResponses({ hasIssuesEnabled: false, pullRequestCount: 0 }),
    );
    use(fake);
    const res = await sync(WINDOW).expect(202);
    await runner.whenIdle();

    expect(await getJob(res.body.id)).toMatchObject({
      status: 'succeeded',
      counts: { pullRequests: 0, reviews: 0, issues: 0, commits: 2 },
    });
    expect(await repository()).toMatchObject({
      hasPullRequests: false,
      hasIssuesEnabled: false,
    });
    expect(fake.callsTo(ISSUES_QUERY)).toHaveLength(0);
    expect(fake.callsTo(PULL_REQUESTS_QUERY)).toHaveLength(0);
  });

  it('fails the job with the error kind only, keeps page progress, and does not advance coverage', async () => {
    use(
      new FakeGitHubClient({
        ...smallRepoResponses(),
        [PULL_REQUESTS_QUERY]: [
          PR_PAGE_1,
          new GitHubError('unavailable', 'raw upstream secret-xyz'),
        ],
      }),
    );
    const logged = jest.spyOn(PinoLogger.prototype, 'error');
    const res = await sync(WINDOW).expect(202);
    await runner.whenIdle();
    const jobLogs = logged.mock.calls.filter((args) =>
      inspect(args).includes(res.body.id),
    );
    logged.mockRestore();
    expect(jobLogs).toHaveLength(1);
    expect(jobLogs[0][0]).toEqual({
      jobId: res.body.id,
      kind: 'unavailable',
      status: undefined,
    });
    expect(inspect(jobLogs, { depth: 10 })).not.toContain('secret-xyz');

    const job = await getJob(res.body.id);
    expect(job).toMatchObject({
      status: 'failed',
      error: 'unavailable',
      counts: { pullRequests: 2, reviews: 2, issues: 0, commits: 0 },
    });
    expect(job.finishedAt).not.toBeNull();
    expect(JSON.stringify(job)).not.toContain('secret-xyz');
    expect(await repository()).toMatchObject({
      coveredFrom: null,
      coveredTo: null,
      lastSyncedAt: null,
    });

    use(fake);
    const retry = await sync(WINDOW).expect(202);
    expect(retry.body.mode).toBe('initial');
  });

  it("records 'internal' for a non-GitHub failure", async () => {
    use(
      new FakeGitHubClient({
        ...smallRepoResponses(),
        [ISSUES_QUERY]: () => {
          throw new TypeError('cannot read properties of undefined');
        },
      }),
    );
    const res = await sync(WINDOW).expect(202);
    await runner.whenIdle();
    expect(await getJob(res.body.id)).toMatchObject({
      status: 'failed',
      error: 'internal',
    });
  });

  it('marks jobs left queued or running by a previous process as failed', async () => {
    await sync(WINDOW).expect(202);
    await runner.whenIdle();
    const repo = await repository();
    const orphan = await prisma.syncJob.create({
      data: {
        repositoryId: repo.id,
        status: 'running',
        mode: 'incremental',
        requestedFrom: new Date(iso(WINDOW.from)),
        requestedTo: new Date(iso(WINDOW.to)),
        startedAt: new Date(),
      },
    });

    await runner.recoverInterruptedJobs();
    expect(await getJob(orphan.id)).toMatchObject({
      status: 'failed',
      error: 'interrupted',
    });
  });

  it('GET /sync-jobs/:id returns 404 for an unknown id and 400 for a non-uuid', async () => {
    const missing = await request(app.getHttpServer())
      .get('/api/v1/sync-jobs/6f1c2c51-8a37-4f39-9a32-0c1f4f0f7b1e')
      .expect(404);
    expect(missing.body.type).toBe(`${PROBLEM}not-found`);
    await request(app.getHttpServer())
      .get('/api/v1/sync-jobs/not-a-uuid')
      .expect(400);
  });
});
