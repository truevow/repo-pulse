import { PrismaService } from '../src/prisma/prisma.service';
import {
  upsertCommits,
  upsertIssues,
  upsertPullRequests,
  upsertReviews,
} from '../src/ingestion/upserts';
import {
  COMMITS,
  ISSUE_PAGE,
  OVERFLOW_REVIEWS,
  PR_PAGE_1,
  PR_PAGE_2,
  REVIEW_OVERFLOW_CURSOR,
} from './fixtures/github/small-repo';
import { resetDatabase } from './setup/db';

const PR_NODES = [
  ...PR_PAGE_1.repository!.pullRequests.nodes,
  ...PR_PAGE_2.repository!.pullRequests.nodes,
];
const ISSUE_NODES = ISSUE_PAGE.repository!.issues.nodes;

describe('ingestion upserts (DB)', () => {
  const prisma = new PrismaService();
  let repositoryId: number;

  beforeAll(async () => {
    await prisma.$connect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    const repo = await prisma.repository.create({
      data: {
        githubId: 'R_kgDOwidgets',
        owner: 'acme',
        name: 'widgets',
        defaultBranch: 'main',
        hasIssuesEnabled: true,
      },
    });
    repositoryId = repo.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('upserting the same PR page twice keeps one row per PR and review', async () => {
    const first = await prisma.$transaction((tx) =>
      upsertPullRequests(tx, repositoryId, PR_NODES),
    );
    const second = await prisma.$transaction((tx) =>
      upsertPullRequests(tx, repositoryId, PR_NODES),
    );

    const expected = {
      pullRequests: 3,
      reviews: 3,
      overflow: [{ githubId: 'PR_3', after: REVIEW_OVERFLOW_CURSOR }],
    };
    expect(first).toEqual(expected);
    expect(second).toEqual(expected);
    expect(await prisma.pullRequest.count()).toBe(3);
    expect(await prisma.review.count()).toBe(3);
    expect(await prisma.actor.count()).toBe(4);
  });

  it('flags bots by __typename and by [bot] login suffix', async () => {
    await prisma.$transaction((tx) =>
      upsertPullRequests(tx, repositoryId, PR_NODES),
    );
    const actors = await prisma.actor.findMany({ orderBy: { login: 'asc' } });
    expect(actors.map((a) => [a.login, a.isBot])).toEqual([
      ['alice', false],
      ['bob', false],
      ['dependabot', true],
      ['review-helper[bot]', true],
    ]);
  });

  it('maps PR fields, merger and the self-review author', async () => {
    await prisma.$transaction((tx) =>
      upsertPullRequests(tx, repositoryId, PR_NODES),
    );
    const pr = await prisma.pullRequest.findUniqueOrThrow({
      where: { githubId: 'PR_2' },
      include: { author: true, mergedBy: true, reviews: true },
    });
    expect(pr).toMatchObject({
      number: 2,
      state: 'MERGED',
      baseRef: 'main',
      additions: 120,
      mergedAt: new Date('2026-10-15T12:00:00Z'),
      author: { login: 'alice' },
      mergedBy: { login: 'alice' },
    });
    const selfReview = pr.reviews.find((r) => r.githubId === 'R_1')!;
    expect(selfReview.authorId).toBe(pr.authorId);
    expect(selfReview.commentCount).toBe(2);
  });

  it('upserts overflow reviews onto the PR idempotently', async () => {
    await prisma.$transaction((tx) =>
      upsertPullRequests(tx, repositoryId, PR_NODES),
    );
    for (let i = 0; i < 2; i++) {
      const n = await prisma.$transaction((tx) =>
        upsertReviews(tx, 'PR_3', OVERFLOW_REVIEWS),
      );
      expect(n).toBe(1);
    }
    expect(await prisma.review.count()).toBe(4);
    const reviews = await prisma.review.findMany({
      where: { pullRequest: { githubId: 'PR_3' } },
      orderBy: { githubId: 'asc' },
    });
    expect(reviews.map((r) => [r.githubId, r.state])).toEqual([
      ['R_3', 'APPROVED'],
      ['R_4', 'CHANGES_REQUESTED'],
    ]);
  });

  it('upserts issues with labels and bot authors', async () => {
    for (let i = 0; i < 2; i++) {
      const n = await prisma.$transaction((tx) =>
        upsertIssues(tx, repositoryId, ISSUE_NODES),
      );
      expect(n).toBe(2);
    }
    const issues = await prisma.issue.findMany({
      orderBy: { number: 'asc' },
      include: { author: true },
    });
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({
      number: 10,
      state: 'OPEN',
      labels: ['bug', 'ui'],
      author: { login: 'carol', isBot: false },
    });
    expect(issues[1]).toMatchObject({
      number: 11,
      state: 'CLOSED',
      closedAt: new Date('2026-09-16T02:00:00Z'),
      author: { login: 'github-actions', isBot: true },
    });
  });

  it('stores a commit without a GitHub user as unlinked with its author name', async () => {
    for (let i = 0; i < 2; i++) {
      const n = await prisma.$transaction((tx) =>
        upsertCommits(tx, repositoryId, COMMITS),
      );
      expect(n).toBe(2);
    }
    const commits = await prisma.commit.findMany({
      orderBy: { sha: 'asc' },
      include: { author: true },
    });
    expect(commits).toHaveLength(2);
    expect(commits[0]).toMatchObject({
      sha: 'a'.repeat(40),
      authorName: 'Alice A.',
      author: { login: 'alice' },
    });
    expect(commits[1]).toMatchObject({
      sha: 'b'.repeat(40),
      authorId: null,
      authorName: 'Jane Offline',
      additions: 7,
    });
  });
});
