import type { Snapshot } from '../../../src/snapshot/snapshot.types';
import { METRICS_WINDOW, W1, W2, W3, W4 } from './metrics-fixture';

/**
 * A commits-only repository: pull requests and issues are disabled on GitHub,
 * so no PR, review or issue rows exist. Four ISO weeks, the same window as the
 * metrics fixture (W1..W4), with commits by two authors:
 *   W1 alice 3, bob 1; W2 alice 1; W3 none; W4 bob 2.
 */
export const PR_DISABLED_OWNER = 'acme';
export const PR_DISABLED_REPO = 'commits-only';

/** Commits per week, in W1..W4 order. */
export const PR_DISABLED_COMMITS: Record<string, number> = {
  [W1]: 4,
  [W2]: 1,
  [W3]: 0,
  [W4]: 2,
};

const sha = (n: number): string =>
  `b${n.toString(16).padStart(6, '0')}${'0'.repeat(33)}`;

let seq = 0;
function commit(author: string, at: string): Snapshot['commits'][number] {
  seq += 1;
  return {
    sha: sha(seq),
    author,
    authorName: author[0].toUpperCase() + author.slice(1),
    committedDate: `${at}:00.000Z`,
    additions: 10 * seq,
    deletions: seq,
  };
}

export function prDisabledFixture(): Snapshot {
  seq = 0;
  return {
    version: 1,
    exportedAt: '2026-10-28T00:00:00.000Z',
    repository: {
      githubId: 'R_commits_only',
      owner: PR_DISABLED_OWNER,
      name: PR_DISABLED_REPO,
      defaultBranch: 'trunk',
      hasIssuesEnabled: false,
      hasPullRequests: false,
      coveredFrom: METRICS_WINDOW.from.toISOString(),
      coveredTo: METRICS_WINDOW.to.toISOString(),
      lastSyncedAt: METRICS_WINDOW.to.toISOString(),
    },
    actors: [
      { login: 'alice', isBot: false },
      { login: 'bob', isBot: false },
    ],
    pullRequests: [],
    issues: [],
    commits: [
      commit('alice', '2026-09-07T10:00'),
      commit('alice', '2026-09-08T10:00'),
      commit('alice', '2026-09-09T10:00'),
      commit('bob', '2026-09-10T10:00'),
      commit('alice', '2026-09-15T10:00'),
      commit('bob', '2026-09-29T10:00'),
      commit('bob', '2026-10-01T10:00'),
    ],
  };
}
