import { PrismaService } from '../src/prisma/prisma.service';
import { exportSnapshot, loadSnapshot } from '../src/snapshot/snapshot.service';
import type { Snapshot } from '../src/snapshot/snapshot.types';
import { resetDatabase } from './setup/db';

const SNAPSHOT: Snapshot = {
  version: 1,
  exportedAt: '2026-01-01T00:00:00.000Z',
  repository: {
    githubId: 'R_kgDOwidgets',
    owner: 'acme',
    name: 'widgets',
    defaultBranch: 'main',
    hasIssuesEnabled: true,
    hasPullRequests: true,
    coveredFrom: '2025-10-01T00:00:00.000Z',
    coveredTo: '2025-12-31T00:00:00.000Z',
    lastSyncedAt: '2026-01-01T00:00:00.000Z',
  },
  actors: [
    { login: 'alice', isBot: false },
    { login: 'bob', isBot: false },
    { login: 'dependabot[bot]', isBot: true },
  ],
  pullRequests: [
    {
      githubId: 'PR_1',
      number: 1,
      title: 'Add widget',
      author: 'alice',
      mergedBy: 'bob',
      state: 'MERGED',
      isDraft: false,
      createdAt: '2025-10-02T10:00:00.000Z',
      updatedAt: '2025-10-03T10:00:00.000Z',
      mergedAt: '2025-10-03T10:00:00.000Z',
      closedAt: '2025-10-03T10:00:00.000Z',
      additions: 10,
      deletions: 2,
      changedFiles: 3,
      baseRef: 'main',
      reviews: [
        {
          githubId: 'RV_1',
          author: 'alice',
          state: 'COMMENTED',
          submittedAt: '2025-10-02T11:00:00.000Z',
          commentCount: 1,
        },
        {
          githubId: 'RV_2',
          author: 'bob',
          state: 'APPROVED',
          submittedAt: '2025-10-03T09:00:00.000Z',
          commentCount: 0,
        },
      ],
    },
    {
      githubId: 'PR_2',
      number: 2,
      title: 'Bump deps',
      author: 'dependabot[bot]',
      mergedBy: null,
      state: 'OPEN',
      isDraft: true,
      createdAt: '2025-11-02T10:00:00.000Z',
      updatedAt: '2025-11-02T10:00:00.000Z',
      mergedAt: null,
      closedAt: null,
      additions: 1,
      deletions: 1,
      changedFiles: 1,
      baseRef: 'main',
      reviews: [],
    },
  ],
  issues: [
    {
      githubId: 'I_1',
      number: 3,
      title: 'Broken',
      author: 'bob',
      state: 'CLOSED',
      createdAt: '2025-10-05T10:00:00.000Z',
      updatedAt: '2025-10-06T10:00:00.000Z',
      closedAt: '2025-10-06T10:00:00.000Z',
      labels: ['bug', 'a-first', 'zeta'],
    },
  ],
  commits: [
    {
      sha: 'aaa111',
      author: 'alice',
      authorName: 'Alice A',
      committedDate: '2025-10-02T09:00:00.000Z',
      additions: 10,
      deletions: 2,
    },
    {
      sha: 'bbb222',
      author: null,
      authorName: 'Ghost',
      committedDate: '2025-10-04T09:00:00.000Z',
      additions: 0,
      deletions: 5,
    },
  ],
};

function strip(s: Snapshot): Omit<Snapshot, 'exportedAt'> {
  const { exportedAt: _ignored, ...rest } = s;
  void _ignored;
  return rest;
}

describe('snapshot export/load (DB)', () => {
  const prisma = new PrismaService();

  const counts = async () => ({
    repositories: await prisma.repository.count(),
    actors: await prisma.actor.count(),
    pullRequests: await prisma.pullRequest.count(),
    reviews: await prisma.review.count(),
    issues: await prisma.issue.count(),
    commits: await prisma.commit.count(),
  });

  beforeAll(async () => {
    await prisma.$connect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('round-trips load -> export exactly', async () => {
    await loadSnapshot(prisma, SNAPSHOT);
    const exported = await exportSnapshot(prisma, 'acme', 'widgets');
    expect(strip(exported)).toEqual(strip(SNAPSHOT));
    expect(exported.version).toBe(1);
    expect(Number.isNaN(Date.parse(exported.exportedAt))).toBe(false);
  });

  it('is idempotent: loading twice leaves identical row counts', async () => {
    await loadSnapshot(prisma, SNAPSHOT);
    const first = await counts();
    await loadSnapshot(prisma, SNAPSHOT);
    expect(await counts()).toEqual(first);
    expect(first).toEqual({
      repositories: 1,
      actors: 3,
      pullRequests: 2,
      reviews: 2,
      issues: 1,
      commits: 2,
    });
  });

  it('round-trips an exported snapshot into a reset database', async () => {
    await loadSnapshot(prisma, SNAPSHOT);
    const exported = await exportSnapshot(prisma, 'acme', 'widgets');
    await resetDatabase(prisma);
    await loadSnapshot(prisma, exported);
    const again = await exportSnapshot(prisma, 'acme', 'widgets');
    expect(strip(again)).toEqual(strip(SNAPSHOT));
  });

  it('rejects unsupported versions and leaves the DB unchanged', async () => {
    const bad = { version: 2 } as unknown as Snapshot;
    await expect(loadSnapshot(prisma, bad)).rejects.toThrow(/version/i);
    expect(await counts()).toEqual({
      repositories: 0,
      actors: 0,
      pullRequests: 0,
      reviews: 0,
      issues: 0,
      commits: 0,
    });
  });

  it('rejects exporting an unknown repository', async () => {
    await expect(exportSnapshot(prisma, 'no', 'such')).rejects.toThrow(
      /not found/i,
    );
  });
});
