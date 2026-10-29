import type { IssueState, Prisma, PrState, ReviewState } from '@prisma/client';
import type {
  ActorNode,
  CommitNode,
  IssueNode,
  PullRequestNode,
  ReviewNode,
} from '../github/github.types';
import { actorRef, ensureActors, type ActorRef } from './actors';

type Tx = Prisma.TransactionClient;
type ActorIds = Map<string, number>;

export interface ReviewOverflow {
  githubId: string;
  after: string;
}

const PR_STATES: readonly PrState[] = ['OPEN', 'MERGED', 'CLOSED'];
const ISSUE_STATES: readonly IssueState[] = ['OPEN', 'CLOSED'];
const REVIEW_STATES: readonly ReviewState[] = [
  'APPROVED',
  'CHANGES_REQUESTED',
  'COMMENTED',
  'DISMISSED',
  'PENDING',
];

function oneOf<T extends string>(allowed: readonly T[], value: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`Unexpected GitHub state: ${value}`);
  }
  return value as T;
}

function refs(actors: ActorNode[]): ActorRef[] {
  return actors.map(actorRef).filter((r): r is ActorRef => r !== null);
}

function actorId(ids: ActorIds, actor: ActorNode): number | null {
  return actor?.login ? (ids.get(actor.login) ?? null) : null;
}

const date = (value: string | null): Date | null =>
  value === null ? null : new Date(value);

/** Reviews without `submittedAt` (pending drafts) are not stored. */
function submitted(
  nodes: ReviewNode[],
): Array<ReviewNode & { submittedAt: string }> {
  return nodes.filter(
    (n): n is ReviewNode & { submittedAt: string } => n.submittedAt !== null,
  );
}

async function upsertReviewRows(
  tx: Tx,
  pullRequestId: number,
  nodes: ReviewNode[],
  ids: ActorIds,
): Promise<number> {
  const rows = submitted(nodes);
  for (const node of rows) {
    const data = {
      authorId: actorId(ids, node.author),
      state: oneOf(REVIEW_STATES, node.state),
      submittedAt: new Date(node.submittedAt),
      commentCount: node.comments.totalCount,
    };
    await tx.review.upsert({
      where: { githubId: node.id },
      create: { githubId: node.id, pullRequestId, ...data },
      update: { pullRequestId, ...data },
    });
  }
  return rows.length;
}

/**
 * Upserts PRs and their nested reviews by githubId. PRs whose nested review
 * page has more are returned in `overflow` for follow-up review queries.
 */
export async function upsertPullRequests(
  tx: Tx,
  repositoryId: number,
  nodes: PullRequestNode[],
): Promise<{
  pullRequests: number;
  reviews: number;
  overflow: ReviewOverflow[];
}> {
  const ids = await ensureActors(
    tx,
    refs(
      nodes.flatMap((n) => [
        n.author,
        n.mergedBy,
        ...n.reviews.nodes.map((r) => r.author),
      ]),
    ),
  );
  let reviews = 0;
  const overflow: ReviewOverflow[] = [];
  for (const node of nodes) {
    const data = {
      repositoryId,
      number: node.number,
      title: node.title,
      authorId: actorId(ids, node.author),
      mergedById: actorId(ids, node.mergedBy),
      state: oneOf(PR_STATES, node.state),
      isDraft: node.isDraft,
      createdAt: new Date(node.createdAt),
      updatedAt: new Date(node.updatedAt),
      mergedAt: date(node.mergedAt),
      closedAt: date(node.closedAt),
      additions: node.additions,
      deletions: node.deletions,
      changedFiles: node.changedFiles,
      baseRef: node.baseRefName,
    };
    const pr = await tx.pullRequest.upsert({
      where: { githubId: node.id },
      create: { githubId: node.id, ...data },
      update: data,
      select: { id: true },
    });
    reviews += await upsertReviewRows(tx, pr.id, node.reviews.nodes, ids);
    const { hasNextPage, endCursor } = node.reviews.pageInfo;
    if (hasNextPage && endCursor) {
      overflow.push({ githubId: node.id, after: endCursor });
    }
  }
  return { pullRequests: nodes.length, reviews, overflow };
}

/** Upserts a follow-up page of reviews for an already stored PR. */
export async function upsertReviews(
  tx: Tx,
  pullRequestGithubId: string,
  nodes: ReviewNode[],
): Promise<number> {
  const pr = await tx.pullRequest.findUniqueOrThrow({
    where: { githubId: pullRequestGithubId },
    select: { id: true },
  });
  const ids = await ensureActors(tx, refs(nodes.map((n) => n.author)));
  return upsertReviewRows(tx, pr.id, nodes, ids);
}

export async function upsertIssues(
  tx: Tx,
  repositoryId: number,
  nodes: IssueNode[],
): Promise<number> {
  const ids = await ensureActors(tx, refs(nodes.map((n) => n.author)));
  for (const node of nodes) {
    const data = {
      repositoryId,
      number: node.number,
      title: node.title,
      authorId: actorId(ids, node.author),
      state: oneOf(ISSUE_STATES, node.state),
      createdAt: new Date(node.createdAt),
      updatedAt: new Date(node.updatedAt),
      closedAt: date(node.closedAt),
      labels: node.labels.nodes.map((l) => l.name),
    };
    await tx.issue.upsert({
      where: { githubId: node.id },
      create: { githubId: node.id, ...data },
      update: data,
    });
  }
  return nodes.length;
}

/** Commits without a GitHub user are stored unlinked under the git author name. */
export async function upsertCommits(
  tx: Tx,
  repositoryId: number,
  nodes: CommitNode[],
): Promise<number> {
  const userActor = (n: CommitNode): ActorNode =>
    n.author?.user ? { __typename: 'User', login: n.author.user.login } : null;
  const ids = await ensureActors(tx, refs(nodes.map(userActor)));
  for (const node of nodes) {
    const login = node.author?.user?.login;
    const data = {
      authorId: actorId(ids, userActor(node)),
      authorName: node.author?.name ?? login ?? 'unknown',
      committedDate: new Date(node.committedDate),
      additions: node.additions,
      deletions: node.deletions,
    };
    await tx.commit.upsert({
      where: { repositoryId_sha: { repositoryId, sha: node.oid } },
      create: { repositoryId, sha: node.oid, ...data },
      update: data,
    });
  }
  return nodes.length;
}
