import type { Prisma, PrismaClient } from '@prisma/client';
import { ensureActors } from '../ingestion/actors';
import type { Snapshot } from './snapshot.types';

const CHUNK = 500;
const TX_TIMEOUT_MS = 120_000;

const iso = (d: Date): string => d.toISOString();
const isoOrNull = (d: Date | null): string | null => (d ? iso(d) : null);
const date = (s: string): Date => new Date(s);
const dateOrNull = (s: string | null): Date | null => (s ? new Date(s) : null);

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Runs `fn` over `items` in chunks of CHUNK, each chunk concurrently. */
async function inChunks<T>(
  items: T[],
  fn: (item: T) => Promise<unknown>,
): Promise<void> {
  for (let i = 0; i < items.length; i += CHUNK) {
    await Promise.all(items.slice(i, i + CHUNK).map(fn));
  }
}

export async function exportSnapshot(
  prisma: PrismaClient,
  owner: string,
  name: string,
): Promise<Snapshot> {
  const repo = await prisma.repository.findUnique({
    where: { owner_name: { owner, name } },
  });
  if (!repo) throw new Error(`Repository ${owner}/${name} not found`);
  if (!repo.coveredFrom || !repo.coveredTo || !repo.lastSyncedAt) {
    throw new Error(`Repository ${owner}/${name} has never been synced`);
  }

  const [prs, issues, commits] = await Promise.all([
    prisma.pullRequest.findMany({
      where: { repositoryId: repo.id },
      orderBy: { number: 'asc' },
      include: {
        author: true,
        mergedBy: true,
        reviews: { include: { author: true } },
      },
    }),
    prisma.issue.findMany({
      where: { repositoryId: repo.id },
      orderBy: { number: 'asc' },
      include: { author: true },
    }),
    prisma.commit.findMany({
      where: { repositoryId: repo.id },
      include: { author: true },
    }),
  ]);

  const actors = new Map<string, boolean>();
  const note = (a: { login: string; isBot: boolean } | null): string | null => {
    if (!a) return null;
    actors.set(a.login, a.isBot);
    return a.login;
  };

  const pullRequests: Snapshot['pullRequests'] = prs.map((pr) => ({
    githubId: pr.githubId,
    number: pr.number,
    title: pr.title,
    author: note(pr.author),
    mergedBy: note(pr.mergedBy),
    state: pr.state,
    isDraft: pr.isDraft,
    createdAt: iso(pr.createdAt),
    updatedAt: iso(pr.updatedAt),
    mergedAt: isoOrNull(pr.mergedAt),
    closedAt: isoOrNull(pr.closedAt),
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    baseRef: pr.baseRef,
    reviews: [...pr.reviews]
      .sort(
        (a, b) =>
          a.submittedAt.getTime() - b.submittedAt.getTime() ||
          byString(a.githubId, b.githubId),
      )
      .map((r) => ({
        githubId: r.githubId,
        author: note(r.author),
        state: r.state,
        submittedAt: iso(r.submittedAt),
        commentCount: r.commentCount,
      })),
  }));

  const issueRows: Snapshot['issues'] = issues.map((i) => ({
    githubId: i.githubId,
    number: i.number,
    title: i.title,
    author: note(i.author),
    state: i.state,
    createdAt: iso(i.createdAt),
    updatedAt: iso(i.updatedAt),
    closedAt: isoOrNull(i.closedAt),
    labels: i.labels,
  }));

  const commitRows: Snapshot['commits'] = [...commits]
    .sort(
      (a, b) =>
        a.committedDate.getTime() - b.committedDate.getTime() ||
        byString(a.sha, b.sha),
    )
    .map((c) => ({
      sha: c.sha,
      author: note(c.author),
      authorName: c.authorName,
      committedDate: iso(c.committedDate),
      additions: c.additions,
      deletions: c.deletions,
    }));

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    repository: {
      githubId: repo.githubId,
      owner: repo.owner,
      name: repo.name,
      defaultBranch: repo.defaultBranch,
      hasIssuesEnabled: repo.hasIssuesEnabled,
      hasPullRequests: repo.hasPullRequests,
      coveredFrom: iso(repo.coveredFrom),
      coveredTo: iso(repo.coveredTo),
      lastSyncedAt: iso(repo.lastSyncedAt),
    },
    actors: [...actors]
      .map(([login, isBot]) => ({ login, isBot }))
      .sort((a, b) => byString(a.login, b.login)),
    pullRequests,
    issues: issueRows,
    commits: commitRows,
  };
}

/** Upserts a whole snapshot in one transaction. Idempotent. */
export async function loadSnapshot(
  prisma: PrismaClient,
  snapshot: Snapshot,
): Promise<{ repositoryId: number }> {
  const r = snapshot.repository;
  return prisma.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const repoData = {
        githubId: r.githubId,
        defaultBranch: r.defaultBranch,
        hasIssuesEnabled: r.hasIssuesEnabled,
        hasPullRequests: r.hasPullRequests,
        coveredFrom: date(r.coveredFrom),
        coveredTo: date(r.coveredTo),
        lastSyncedAt: date(r.lastSyncedAt),
      };
      const repo = await tx.repository.upsert({
        where: { owner_name: { owner: r.owner, name: r.name } },
        create: { owner: r.owner, name: r.name, ...repoData },
        update: repoData,
        select: { id: true },
      });
      const repositoryId = repo.id;

      // Every login referenced anywhere gets a row, even if `actors` omits it.
      const refs = new Map<string, boolean>();
      for (const a of snapshot.actors) refs.set(a.login, a.isBot);
      const mention = (login: string | null) => {
        if (login && !refs.has(login)) refs.set(login, false);
      };
      for (const pr of snapshot.pullRequests) {
        mention(pr.author);
        mention(pr.mergedBy);
        for (const rv of pr.reviews) mention(rv.author);
      }
      for (const i of snapshot.issues) mention(i.author);
      for (const c of snapshot.commits) mention(c.author);
      const actorIds = await ensureActors(
        tx,
        [...refs].map(([login, isBot]) => ({ login, isBot })),
      );
      const id = (login: string | null): number | null =>
        login ? (actorIds.get(login) ?? null) : null;

      const prIds = new Map<string, number>();
      await inChunks(snapshot.pullRequests, async (pr) => {
        const data = {
          repositoryId,
          number: pr.number,
          title: pr.title,
          authorId: id(pr.author),
          mergedById: id(pr.mergedBy),
          state: pr.state,
          isDraft: pr.isDraft,
          createdAt: date(pr.createdAt),
          updatedAt: date(pr.updatedAt),
          mergedAt: dateOrNull(pr.mergedAt),
          closedAt: dateOrNull(pr.closedAt),
          additions: pr.additions,
          deletions: pr.deletions,
          changedFiles: pr.changedFiles,
          baseRef: pr.baseRef,
        };
        const row = await tx.pullRequest.upsert({
          where: { githubId: pr.githubId },
          create: { githubId: pr.githubId, ...data },
          update: data,
          select: { id: true },
        });
        prIds.set(pr.githubId, row.id);
      });

      const reviews = snapshot.pullRequests.flatMap((pr) =>
        pr.reviews.map((rv) => ({ pullRequestGithubId: pr.githubId, rv })),
      );
      await inChunks(reviews, ({ pullRequestGithubId, rv }) => {
        const data = {
          pullRequestId: prIds.get(pullRequestGithubId)!,
          authorId: id(rv.author),
          state: rv.state,
          submittedAt: date(rv.submittedAt),
          commentCount: rv.commentCount,
        };
        return tx.review.upsert({
          where: { githubId: rv.githubId },
          create: { githubId: rv.githubId, ...data },
          update: data,
        });
      });

      await inChunks(snapshot.issues, (i) => {
        const data = {
          repositoryId,
          number: i.number,
          title: i.title,
          authorId: id(i.author),
          state: i.state,
          createdAt: date(i.createdAt),
          updatedAt: date(i.updatedAt),
          closedAt: dateOrNull(i.closedAt),
          labels: i.labels,
        };
        return tx.issue.upsert({
          where: { githubId: i.githubId },
          create: { githubId: i.githubId, ...data },
          update: data,
        });
      });

      await inChunks(snapshot.commits, (c) => {
        const data = {
          authorId: id(c.author),
          authorName: c.authorName,
          committedDate: date(c.committedDate),
          additions: c.additions,
          deletions: c.deletions,
        };
        return tx.commit.upsert({
          where: { repositoryId_sha: { repositoryId, sha: c.sha } },
          create: { repositoryId, sha: c.sha, ...data },
          update: data,
        });
      });

      return { repositoryId };
    },
    { timeout: TX_TIMEOUT_MS, maxWait: 10_000 },
  );
}
