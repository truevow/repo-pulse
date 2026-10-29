import type { Window } from '../../../src/signals/buckets';
import type {
  BucketMetricsRow,
  ContributorActivityRow,
  Leaderboards,
} from '../../../src/signals/leaderboards.types';
import type { Snapshot } from '../../../src/snapshot/snapshot.types';

/**
 * Synthetic 4-week snapshot whose metrics are all computable by hand.
 *
 * Window: four ISO weeks, Mon 2026-09-07 .. Sun 2026-10-04 (to = 10-05, exclusive)
 *   W1 = 09-07..09-13, W2 = 09-14..09-20, W3 = 09-21..09-27 (empty), W4 = 09-28..10-04
 * Actors: alice, bob, carol, dave, renovate[bot] (isBot).
 *
 * Traps planted on purpose (each would change a number if mishandled):
 *   - self-review by bob on his own PR #3 at 1h      (would make W1 first-review p50 = 2)
 *   - PENDING review by dave on #3 at 3h             (would make W1 first-review p50 = 3)
 *   - DISMISSED review by carol on #4                (counts; without it W2 p50 = 11)
 *   - renovate[bot] reviews in W4                    (only with includeBots)
 *   - PR #9 created before the window, merged in W4  (counts in W4 merge metrics)
 *   - issue #23 created before the window, closed W4 (counts in W4 close metrics)
 *   - bob's review on #8 at 10-06, after the window  (never counts)
 *   - carol commits at 09-06T23:59:59 and 10-05T00:00 (both outside [from, to))
 */

export const OWNER = 'acme';
export const REPO = 'metrics';

export const METRICS_WINDOW: Window = {
  from: new Date('2026-09-07T00:00:00.000Z'),
  to: new Date('2026-10-05T00:00:00.000Z'),
};

export const W1 = '2026-09-07';
export const W2 = '2026-09-14';
export const W3 = '2026-09-21';
export const W4 = '2026-09-28';

type Pr = Snapshot['pullRequests'][number];
type Review = Pr['reviews'][number];
type Commit = Snapshot['commits'][number];
type Issue = Snapshot['issues'][number];

/** `'2026-09-07T10:00'` -> `'2026-09-07T10:00:00.000Z'`. */
const t = (s: string): string =>
  s.length === 16 ? `${s}:00.000Z` : `${s}.000Z`;

let reviewSeq = 0;
function review(author: string, state: Review['state'], at: string): Review {
  reviewSeq += 1;
  return {
    githubId: `RV_${reviewSeq}`,
    author,
    state,
    submittedAt: t(at),
    commentCount: 0,
  };
}

function pr(p: {
  number: number;
  author: string;
  createdAt: string;
  mergedAt?: string;
  mergedBy?: string;
  closedAt?: string;
  additions: number;
  deletions: number;
  reviews?: Review[];
}): Pr {
  const mergedAt = p.mergedAt ? t(p.mergedAt) : null;
  const closedAt = mergedAt ?? (p.closedAt ? t(p.closedAt) : null);
  return {
    githubId: `PR_${p.number}`,
    number: p.number,
    title: `PR ${p.number}`,
    author: p.author,
    mergedBy: p.mergedBy ?? null,
    state: mergedAt ? 'MERGED' : closedAt ? 'CLOSED' : 'OPEN',
    isDraft: false,
    createdAt: t(p.createdAt),
    updatedAt: closedAt ?? t(p.createdAt),
    mergedAt,
    closedAt,
    additions: p.additions,
    deletions: p.deletions,
    changedFiles: 1,
    baseRef: 'main',
    reviews: p.reviews ?? [],
  };
}

function issue(
  number: number,
  author: string,
  createdAt: string,
  closedAt?: string,
): Issue {
  return {
    githubId: `I_${number}`,
    number,
    title: `Issue ${number}`,
    author,
    state: closedAt ? 'CLOSED' : 'OPEN',
    createdAt: t(createdAt),
    updatedAt: t(closedAt ?? createdAt),
    closedAt: closedAt ? t(closedAt) : null,
    labels: [],
  };
}

let commitSeq = 0;
/** Deterministic 40-char sha; the 7-char ref is `a` + 6 hex digits. */
export const shaOf = (n: number): string =>
  `a${n.toString(16).padStart(6, '0')}${'0'.repeat(33)}`;
function commit(
  author: string | null,
  authorName: string,
  at: string,
  additions: number,
  deletions: number,
): Commit {
  commitSeq += 1;
  return {
    sha: shaOf(commitSeq),
    author,
    authorName,
    committedDate: t(at),
    additions,
    deletions,
  };
}
const times = (n: number, f: (i: number) => Commit): Commit[] =>
  Array.from({ length: n }, (_, i) => f(i));

const PULL_REQUESTS: Pr[] = [
  // ---- W1 ----
  // #1 first review: alice 09-07T12:00 - 09-07T10:00 = 2h. Merged 48h later (W1).
  pr({
    number: 1,
    author: 'carol',
    createdAt: '2026-09-07T10:00',
    mergedAt: '2026-09-09T10:00',
    mergedBy: 'bob',
    additions: 30,
    deletions: 10,
    reviews: [
      review('alice', 'APPROVED', '2026-09-07T12:00'),
      review('bob', 'COMMENTED', '2026-09-07T15:00'),
    ],
  }),
  // #2 first review: alice 14:00 - 10:00 = 4h.
  pr({
    number: 2,
    author: 'carol',
    createdAt: '2026-09-08T10:00',
    additions: 5,
    deletions: 5,
    reviews: [review('alice', 'COMMENTED', '2026-09-08T14:00')],
  }),
  // #3 (bob's): self-review at 1h and PENDING at 3h are ignored, so the first
  // review is alice at 09-12T04:00 = 4 days + 4h = 100h after creation.
  pr({
    number: 3,
    author: 'bob',
    createdAt: '2026-09-08T00:00',
    additions: 200,
    deletions: 100,
    reviews: [
      review('bob', 'COMMENTED', '2026-09-08T01:00'),
      review('dave', 'PENDING', '2026-09-08T03:00'),
      review('alice', 'APPROVED', '2026-09-12T04:00'),
    ],
  }),
  // ---- W2 ----
  // #4 first review: carol (DISMISSED still counts) 12:00 - 09:00 = 3h; merged 24h.
  pr({
    number: 4,
    author: 'dave',
    createdAt: '2026-09-14T09:00',
    mergedAt: '2026-09-15T09:00',
    mergedBy: 'bob',
    additions: 12,
    deletions: 8,
    reviews: [
      review('carol', 'DISMISSED', '2026-09-14T12:00'),
      review('alice', 'APPROVED', '2026-09-14T20:00'),
    ],
  }),
  // #5 merged 09-17T00:00 - 09-15T00:00 = 48h.
  pr({
    number: 5,
    author: 'alice',
    createdAt: '2026-09-15T00:00',
    mergedAt: '2026-09-17T00:00',
    mergedBy: 'carol',
    additions: 1,
    deletions: 1,
  }),
  // ---- W3: nothing ----
  // ---- W4 ----
  // #6 first review: bot at 1h (with bots) / alice at 6h (without).
  pr({
    number: 6,
    author: 'carol',
    createdAt: '2026-09-28T08:00',
    additions: 50,
    deletions: 0,
    reviews: [
      review('renovate[bot]', 'COMMENTED', '2026-09-28T09:00'),
      review('renovate[bot]', 'COMMENTED', '2026-09-28T10:00'),
      review('alice', 'APPROVED', '2026-09-28T14:00'),
    ],
  }),
  // #7 closed unmerged; first review: bot at 2h (with bots) / bob at 5h (without).
  pr({
    number: 7,
    author: 'dave',
    createdAt: '2026-09-29T00:00',
    closedAt: '2026-09-30T12:00',
    additions: 4,
    deletions: 4,
    reviews: [
      review('renovate[bot]', 'COMMENTED', '2026-09-29T02:00'),
      review('bob', 'CHANGES_REQUESTED', '2026-09-29T05:00'),
    ],
  }),
  // #8 opened in W4; its only review lands after the window.
  pr({
    number: 8,
    author: 'alice',
    createdAt: '2026-10-02T00:00',
    additions: 1,
    deletions: 0,
    reviews: [review('bob', 'APPROVED', '2026-10-06T00:00')],
  }),
  // #9 created before the window, merged in W4: 09-01 -> 09-29 = 28d = 672h.
  pr({
    number: 9,
    author: 'dave',
    createdAt: '2026-09-01T00:00',
    mergedAt: '2026-09-29T00:00',
    mergedBy: 'bob',
    additions: 70,
    deletions: 30,
  }),
];

const ISSUES: Issue[] = [
  issue(20, 'dave', '2026-09-07T00:00', '2026-09-09T00:00'), // W1 open+close, 48h
  issue(21, 'carol', '2026-09-08T00:00', '2026-09-16T00:00'), // W1 open, W2 close, 192h
  issue(22, 'alice', '2026-09-15T00:00'), // W2 open, still open
  issue(23, 'dave', '2026-08-31T00:00', '2026-09-30T00:00'), // pre-window open, W4 close, 720h
  issue(24, 'bob', '2026-09-14T00:00', '2026-09-14T12:00'), // W2 open+close, 12h
];

const COMMITS: Commit[] = [
  commit('carol', 'Carol', '2026-09-06T23:59:59', 1000, 0), // before window
  // W1: alice 5 (12 lines each), bob 3 (10 each), carol 2 (20 each)
  ...times(5, (i) =>
    commit('alice', 'Alice', `2026-09-07T${10 + i}:00`, 10, 2),
  ),
  ...times(3, (i) => commit('bob', 'Bob', `2026-09-09T${10 + i}:00`, 5, 5)),
  ...times(2, (i) =>
    commit('carol', 'Carol', `2026-09-11T${10 + i}:00`, 20, 0),
  ),
  // W2: alice 2 (100 each), bob 1 (2), two unlinked authors (3 and 4 lines)
  ...times(2, (i) =>
    commit('alice', 'Alice', `2026-09-15T${10 + i}:00`, 100, 0),
  ),
  commit('bob', 'Bob', '2026-09-16T10:00', 1, 1),
  commit(null, 'Ghost', '2026-09-17T10:00', 3, 0),
  commit(null, 'Phantom', '2026-09-18T10:00', 0, 4),
  // W4: dave 1 (10 lines), renovate[bot] 1 (100 lines)
  commit('dave', 'Dave', '2026-09-30T10:00', 7, 3),
  commit('renovate[bot]', 'renovate[bot]', '2026-10-01T10:00', 50, 50),
  commit('carol', 'Carol', '2026-10-05T00:00', 1000, 0), // at window.to: excluded
];

const shaBy = (author: string, from: string): string =>
  COMMITS.find((c) => c.author === author && c.committedDate >= from)!.sha;
/** The two W4 commits, used by the commit-examples assertions. */
export const W4_BOT_SHA = shaBy('renovate[bot]', t('2026-09-28T00:00'));
export const W4_DAVE_SHA = shaBy('dave', t('2026-09-28T00:00'));

function snapshot(coveredTo: string, extraPrs: Pr[] = []): Snapshot {
  return {
    version: 1,
    exportedAt: '2026-10-28T00:00:00.000Z',
    repository: {
      githubId: 'R_metrics',
      owner: OWNER,
      name: REPO,
      defaultBranch: 'main',
      hasIssuesEnabled: true,
      hasPullRequests: true,
      coveredFrom: '2026-09-07T00:00:00.000Z',
      coveredTo,
      lastSyncedAt: coveredTo,
    },
    actors: [
      { login: 'alice', isBot: false },
      { login: 'bob', isBot: false },
      { login: 'carol', isBot: false },
      { login: 'dave', isBot: false },
      { login: 'renovate[bot]', isBot: true },
    ],
    pullRequests: [...PULL_REQUESTS, ...extraPrs],
    issues: ISSUES,
    commits: COMMITS,
  };
}

export const METRICS_FIXTURE: Snapshot = snapshot('2026-10-05T00:00:00.000Z');

const EMPTY: Omit<BucketMetricsRow, 'bucket'> = {
  prs_opened: 0,
  prs_merged: 0,
  prs_closed_unmerged: 0,
  time_to_first_review_p50_h: null,
  time_to_merge_p50_h: null,
  reviews_submitted: 0,
  approvals: 0,
  review_concentration_top1: null,
  review_concentration_hhi: null,
  issues_opened: 0,
  issues_closed: 0,
  issue_time_to_close_p50_h: null,
  commits: 0,
  active_authors: 0,
  bus_factor_50: null,
  top_reviewer: null,
};

/** Weekly metrics with includeBots = false. */
export const EXPECTED_WEEKS: BucketMetricsRow[] = [
  {
    bucket: W1,
    prs_opened: 3, // #1 #2 #3
    prs_merged: 1, // #1
    prs_closed_unmerged: 0,
    time_to_first_review_p50_h: 4, // median(2, 4, 100)
    time_to_merge_p50_h: 48, // #1: 09-07T10 -> 09-09T10
    reviews_submitted: 4, // alice x3 (#1 #2 #3) + bob x1 (#1); self + PENDING ignored
    approvals: 2, // alice on #1 and #3
    review_concentration_top1: 0.75, // 3 / 4
    review_concentration_hhi: 0.625, // (3^2 + 1^2) / 4^2 = 10/16
    issues_opened: 2, // #20 #21
    issues_closed: 1, // #20
    issue_time_to_close_p50_h: 48, // #20
    commits: 10, // 5 + 3 + 2
    active_authors: 3,
    bus_factor_50: 1, // alice 5/10 = 50% >= 50%
    top_reviewer: 'alice',
  },
  {
    bucket: W2,
    prs_opened: 2, // #4 #5
    prs_merged: 2, // #4 (24h) #5 (48h)
    prs_closed_unmerged: 0,
    time_to_first_review_p50_h: 3, // #4 only: carol (DISMISSED) at 3h
    time_to_merge_p50_h: 36, // median(24, 48)
    reviews_submitted: 2, // carol DISMISSED + alice APPROVED on #4
    approvals: 1,
    review_concentration_top1: 0.5, // 1 / 2
    review_concentration_hhi: 0.5, // (1 + 1) / 4
    issues_opened: 2, // #22 #24
    issues_closed: 2, // #21 (192h) #24 (12h)
    issue_time_to_close_p50_h: 102, // median(12, 192)
    commits: 5, // alice 2, bob 1, Ghost 1, Phantom 1
    active_authors: 4, // unlinked authors count once per name
    bus_factor_50: 2, // alice 2/5 = 40% < 50%; + any 1 -> 3/5 = 60%
    top_reviewer: 'alice', // tie 1-1 with carol, broken by login asc
  },
  { bucket: W3, ...EMPTY },
  {
    bucket: W4,
    prs_opened: 3, // #6 #7 #8
    prs_merged: 1, // #9 (created before the window)
    prs_closed_unmerged: 1, // #7
    time_to_first_review_p50_h: 5.5, // median(#6 alice 6h, #7 bob 5h)
    time_to_merge_p50_h: 672, // #9: 28 days
    reviews_submitted: 2, // alice #6, bob #7 (bot excluded, #8's review is after window)
    approvals: 1, // alice #6
    review_concentration_top1: 0.5,
    review_concentration_hhi: 0.5,
    issues_opened: 0,
    issues_closed: 1, // #23
    issue_time_to_close_p50_h: 720, // 08-31 -> 09-30 = 30 days
    commits: 2, // dave, renovate[bot] (commit metrics always include bots)
    active_authors: 2,
    bus_factor_50: 1, // 1/2 = 50%
    top_reviewer: 'alice', // tie 1-1 with bob
  },
];

/** W4 with includeBots = true (W1..W3 are unchanged: no bot activity there). */
export const EXPECTED_W4_WITH_BOTS: BucketMetricsRow = {
  ...EXPECTED_WEEKS[3],
  time_to_first_review_p50_h: 1.5, // median(#6 bot 1h, #7 bot 2h)
  reviews_submitted: 5, // bot x3, alice, bob
  approvals: 1,
  review_concentration_top1: 0.6, // 3 / 5
  review_concentration_hhi: 0.44, // (9 + 1 + 1) / 25
  top_reviewer: 'renovate[bot]',
};

/**
 * Contributors sort by mergedPrs desc, then login:
 *   merged authored: dave #4 #9 = 2, alice #5 = 1, carol #1 = 1, bob 0
 *   commits in window: alice 5+2 = 7, bob 3+1 = 4, carol 2, dave 1 (boundary commits excluded)
 *   lines: alice 5*12 + 2*100 = 260, bob 3*10 + 2 = 32, carol 2*20 = 40, dave 10
 * Reviewers (non-self, non-PENDING, in window):
 *   alice #1 #2 #3 #4 #6 = 5 (approvals #1 #3 #4 #6 = 4), bob #1 #7 = 2, carol #4 = 1
 * Mergers: bob #1 #4 #9 = 3, carol #5 = 1.
 */
export const EXPECTED_LEADERBOARDS: Leaderboards = {
  contributors: [
    { login: 'dave', mergedPrs: 2, commits: 1, linesChanged: 10 },
    { login: 'alice', mergedPrs: 1, commits: 7, linesChanged: 260 },
    { login: 'carol', mergedPrs: 1, commits: 2, linesChanged: 40 },
    { login: 'bob', mergedPrs: 0, commits: 4, linesChanged: 32 },
  ],
  reviewers: [
    { login: 'alice', reviews: 5, approvals: 4 },
    { login: 'bob', reviews: 2, approvals: 0 },
    { login: 'carol', reviews: 1, approvals: 0 },
  ],
  mergers: [
    { login: 'bob', prsMerged: 3 },
    { login: 'carol', prsMerged: 1 },
  ],
};

export const EXPECTED_LEADERBOARDS_WITH_BOTS: Leaderboards = {
  contributors: [
    ...EXPECTED_LEADERBOARDS.contributors,
    { login: 'renovate[bot]', mergedPrs: 0, commits: 1, linesChanged: 100 },
  ],
  reviewers: [
    { login: 'alice', reviews: 5, approvals: 4 },
    { login: 'renovate[bot]', reviews: 3, approvals: 0 },
    { login: 'bob', reviews: 2, approvals: 0 },
    { login: 'carol', reviews: 1, approvals: 0 },
  ],
  mergers: EXPECTED_LEADERBOARDS.mergers,
};

/** alice: opened #5 (W2) #8 (W4); merged #5 (W2); reviews W1 3, W2 1, W4 1; commits W1 5, W2 2. */
export const EXPECTED_ALICE_ACTIVITY: ContributorActivityRow[] = [
  { bucket: W1, prs_opened: 0, prs_merged: 0, reviews_given: 3, commits: 5 },
  { bucket: W2, prs_opened: 1, prs_merged: 1, reviews_given: 1, commits: 2 },
  { bucket: W3, prs_opened: 0, prs_merged: 0, reviews_given: 0, commits: 0 },
  { bucket: W4, prs_opened: 1, prs_merged: 0, reviews_given: 1, commits: 0 },
];

/** bob: opened #3 (W1); reviews W1 #1 (self-review on #3 ignored), W4 #7; commits W1 3, W2 1. */
export const EXPECTED_BOB_ACTIVITY: ContributorActivityRow[] = [
  { bucket: W1, prs_opened: 1, prs_merged: 0, reviews_given: 1, commits: 3 },
  { bucket: W2, prs_opened: 0, prs_merged: 0, reviews_given: 0, commits: 1 },
  { bucket: W3, prs_opened: 0, prs_merged: 0, reviews_given: 0, commits: 0 },
  { bucket: W4, prs_opened: 0, prs_merged: 0, reviews_given: 1, commits: 0 },
];

// ---------------------------------------------------------------------------
// Latency spike variant (for Task 10's detectors)
// ---------------------------------------------------------------------------

export const SPIKE_WINDOW: Window = {
  from: new Date('2026-09-07T00:00:00.000Z'),
  to: new Date('2026-10-19T00:00:00.000Z'),
};

/**
 * First-review p50 per week, includeBots = false:
 *   W1 4, W2 3, W3 null,
 *   W4 median(#7 5h, #6 6h, #33 190h, #34 200h, #35 210h) = 190   <- spike
 *   W5 (10-05) median(#8 96h, #30 4h, #31 4h) = 4                  (#8's review now in window)
 *   W6 (10-12) #32 3h = 3
 */
export const SPIKE_FIRST_REVIEW_P50: Array<number | null> = [
  4,
  3,
  null,
  190,
  4,
  3,
];
export const SPIKE_W4_SLOWEST_REF = '#35';

const SPIKE_PRS: Pr[] = [
  pr({
    number: 30,
    author: 'carol',
    createdAt: '2026-10-06T10:00',
    additions: 1,
    deletions: 1,
    reviews: [review('alice', 'COMMENTED', '2026-10-06T14:00')], // 4h
  }),
  pr({
    number: 31,
    author: 'carol',
    createdAt: '2026-10-07T10:00',
    additions: 1,
    deletions: 1,
    reviews: [review('alice', 'COMMENTED', '2026-10-07T14:00')], // 4h
  }),
  pr({
    number: 32,
    author: 'carol',
    createdAt: '2026-10-13T09:00',
    additions: 1,
    deletions: 1,
    reviews: [review('alice', 'COMMENTED', '2026-10-13T12:00')], // 3h
  }),
  // Three PRs opened in W3 and first reviewed together at 10-01T00:00 (W4).
  pr({
    number: 33,
    author: 'dave',
    createdAt: '2026-09-23T02:00', // 10-01T00:00 - 190h
    additions: 10,
    deletions: 0,
    reviews: [review('bob', 'COMMENTED', '2026-10-01T00:00')],
  }),
  pr({
    number: 34,
    author: 'dave',
    createdAt: '2026-09-22T16:00', // 10-01T00:00 - 200h
    additions: 10,
    deletions: 0,
    reviews: [review('bob', 'COMMENTED', '2026-10-01T00:00')],
  }),
  pr({
    number: 35,
    author: 'dave',
    createdAt: '2026-09-22T06:00', // 10-01T00:00 - 210h
    additions: 10,
    deletions: 0,
    reviews: [review('bob', 'COMMENTED', '2026-10-01T00:00')],
  }),
];

/** The base fixture over six weeks with a planted W4 first-review latency spike. */
export function withLatencySpike(): Snapshot {
  return snapshot('2026-10-19T00:00:00.000Z', SPIKE_PRS);
}
