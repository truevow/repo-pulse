import { createHash } from 'node:crypto';
import type { Snapshot } from '../../src/snapshot/snapshot.types';

/**
 * Synthetic repositories with planted causes, for the eval suite.
 *
 * `buildSnapshot` is pure: the same spec always yields the same snapshot
 * (seeded mulberry32, no clock, no I/O). Week numbers in perturbations are
 * 1-based: week 1 starts at `spec.start`.
 */

export type Perturbation =
  /** Multiplies first-review latency of PRs opened in `week` by `factor`. */
  | { type: 'latency_spike'; week: number; factor: number }
  /** Drops `login`'s reviews from `week` on; the others review 1.8x slower. */
  | { type: 'reviewer_dropout'; week: number; login: string }
  /** Multiplies the share of PRs that get merged from `fromWeek` on. */
  | { type: 'throughput_shift'; fromWeek: number; factor: number }
  /** Reassigns reviews submitted in `week` so `login` does `share` of them. */
  | { type: 'concentration'; week: number; login: string; share: number }
  /** Commits only: no PRs, no issues, both features flagged off. */
  | { type: 'disable_prs' };

export interface SyntheticSpec {
  owner: string;
  name: string;
  /** A Monday, YYYY-MM-DD. */
  start: string;
  weeks: number;
  prsPerWeek: number;
  authors: string[];
  reviewers: string[];
  baseFirstReviewHours: number;
  baseMergeHours: number;
  seed: number;
  perturbations: Perturbation[];
}

type Pr = Snapshot['pullRequests'][number];
type Review = Pr['reviews'][number];
type Issue = Snapshot['issues'][number];
type Commit = Snapshot['commits'][number];

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const MINUTE_MS = 60_000;

const LATENCY_SIGMA = 0.5;
const MERGE_SIGMA = 0.3;
const MERGED_SHARE = 0.85;
/** Share of unmerged PRs that get closed; the rest stay open. */
const CLOSED_SHARE_OF_UNMERGED = 1 / 3;
const DROPOUT_SLOWDOWN = 1.8;
const ISSUES_PER_WEEK = 5;
const ISSUE_CLOSED_SHARE = 0.6;
const ISSUE_CLOSE_MIN_DAYS = 1;
const ISSUE_CLOSE_MAX_DAYS = 10;
/** Weeks simulated before `start`, so the window opens in steady state. */
const WARMUP_WEEKS = 2;
const EXTRA_COMMITS_PER_WEEK = 3;
const AUTHOR_JITTER = 0.3;

// ---------------------------------------------------------------------------
// Seeded randomness
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  uniform(): number {
    return this.next();
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  /** Standard normal (Box-Muller); always draws two uniforms. */
  normal(): number {
    const u = 1 - this.next();
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  logNormal(median: number, sigma: number): number {
    return median * Math.exp(sigma * this.normal());
  }
}

// ---------------------------------------------------------------------------
// Perturbation lookups (week indices are 0-based here)
// ---------------------------------------------------------------------------

function latencyFactor(ps: Perturbation[], week: number): number {
  let f = 1;
  for (const p of ps) {
    if (p.type === 'latency_spike' && p.week - 1 === week) f *= p.factor;
    if (p.type === 'reviewer_dropout' && week >= p.week - 1) {
      f *= DROPOUT_SLOWDOWN;
    }
  }
  return f;
}

function droppedReviewers(ps: Perturbation[], week: number): Set<string> {
  return new Set(
    ps.flatMap((p) =>
      p.type === 'reviewer_dropout' && week >= p.week - 1 ? [p.login] : [],
    ),
  );
}

function mergedShare(ps: Perturbation[], week: number): number {
  let share = MERGED_SHARE;
  for (const p of ps) {
    if (p.type === 'throughput_shift' && week >= p.fromWeek - 1) {
      share *= p.factor;
    }
  }
  return Math.min(1, share);
}

// ---------------------------------------------------------------------------
// Drafts (timestamps in ms; numbers assigned later)
// ---------------------------------------------------------------------------

interface ReviewDraft {
  author: string;
  at: number;
  state: Review['state'];
}

interface PrDraft {
  kind: 'pr';
  seq: number;
  author: string;
  createdAt: number;
  reviews: ReviewDraft[];
  mergedAt: number | null;
  closedAt: number | null;
  mergedBy: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
}

interface IssueDraft {
  kind: 'issue';
  seq: number;
  author: string;
  createdAt: number;
  closedAt: number | null;
}

const toMinute = (ms: number): number => Math.round(ms / MINUTE_MS) * MINUTE_MS;
const iso = (ms: number): string => new Date(ms).toISOString();
const isoOrNull = (ms: number | null): string | null =>
  ms === null ? null : iso(ms);

/** True for exactly `k` of the indices 0..n-1, spread evenly. */
const evenly = (i: number, k: number, n: number): boolean =>
  Math.floor(((i + 1) * k) / n) > Math.floor((i * k) / n);

/**
 * PRs are drafted from WARMUP_WEEKS before `start` so the first weeks of the
 * window look like steady state (merges and reviews of earlier PRs land in
 * them); the warm-up PRs are kept only if they had activity in the window,
 * as a sync of the window would see them. Creation times, the merged/closed
 * split and reviewer assignment are spread evenly (latencies stay log-normal),
 * so weekly metrics carry little noise beyond the planted perturbations and
 * the detectors stay quiet on the control.
 */
function draftPullRequests(
  spec: SyntheticSpec,
  rng: Rng,
  startMs: number,
  endMs: number,
): PrDraft[] {
  const ps = spec.perturbations;
  const n = spec.prsPerWeek;
  const drafts: PrDraft[] = [];
  let seq = 0;
  let turn = 0;
  for (let w = -WARMUP_WEEKS; w < spec.weeks; w++) {
    const weekStart = startMs + w * WEEK_MS;
    const dropped = droppedReviewers(ps, w);
    const slow = latencyFactor(ps, w);
    // A fixed number of draws per PR, so perturbations never shift the stream.
    const raw = Array.from({ length: n }, () => ({
      jitterU: rng.uniform(),
      jitterBy: rng.int(0, spec.authors.length - 1),
      createdU: rng.uniform(),
      reviewsU: rng.uniform(),
      firstH: rng.logNormal(spec.baseFirstReviewHours, LATENCY_SIGMA),
      secondH: rng.logNormal(4, LATENCY_SIGMA),
      mergeH: rng.logNormal(spec.baseMergeHours, MERGE_SIGMA),
      settleH: rng.logNormal(2, MERGE_SIGMA),
      closeH: rng.logNormal(72, MERGE_SIGMA),
      additions: rng.int(5, 400),
      deletions: rng.int(0, 200),
      changedFiles: rng.int(1, 20),
    }));
    const merged = Math.round(mergedShare(ps, w) * n);
    const closed = Math.round((n - merged) * CLOSED_SHARE_OF_UNMERGED);
    let unmerged = 0;
    const outcome = raw.map((_, i): 'merged' | 'closed' | 'open' => {
      if (evenly(i, merged, n)) return 'merged';
      return evenly(unmerged++, closed, n - merged) ? 'closed' : 'open';
    });

    raw.forEach((r, i) => {
      const jitter = r.jitterU < AUTHOR_JITTER ? r.jitterBy : 0;
      const author =
        spec.authors[
          (((w * n + i + jitter) % spec.authors.length) + spec.authors.length) %
            spec.authors.length
        ];
      const createdAt = toMinute(weekStart + ((i + r.createdU) / n) * WEEK_MS);
      const eligible = spec.reviewers.filter(
        (login) => login !== author && !dropped.has(login),
      );
      // Reviewers take turns, so load stays balanced.
      const want = Math.min(r.reviewsU < 0.5 ? 1 : 2, eligible.length);
      const who = Array.from(
        { length: want },
        (_, k) => eligible[(turn + k) % eligible.length],
      );
      turn += 1;
      const first = toMinute(createdAt + r.firstH * slow * HOUR_MS);
      const times = [first, toMinute(first + r.secondH * slow * HOUR_MS)];
      const reviews: ReviewDraft[] = who.map((login, k) => ({
        author: login,
        at: times[k],
        state: k === who.length - 1 ? 'APPROVED' : 'COMMENTED',
      }));

      const lastReview = reviews.length
        ? reviews[reviews.length - 1].at
        : createdAt;
      let mergedAt: number | null = null;
      let closedAt: number | null = null;
      if (outcome[i] === 'merged') {
        mergedAt = toMinute(
          Math.max(
            createdAt + r.mergeH * HOUR_MS,
            lastReview + r.settleH * HOUR_MS,
          ),
        );
        closedAt = mergedAt;
      } else if (outcome[i] === 'closed') {
        closedAt = toMinute(lastReview + r.closeH * HOUR_MS);
      }
      // Nothing after the sync is visible.
      if (closedAt !== null && closedAt >= endMs) {
        mergedAt = null;
        closedAt = null;
      }
      const visible = reviews.filter((x) => x.at < endMs);
      seq += 1;
      const draft: PrDraft = {
        kind: 'pr',
        seq,
        author,
        createdAt,
        reviews: visible,
        mergedAt,
        closedAt,
        mergedBy: mergedAt === null ? null : (who[who.length - 1] ?? author),
        additions: r.additions,
        deletions: r.deletions,
        changedFiles: r.changedFiles,
      };
      const lastActivity = Math.max(
        createdAt,
        closedAt ?? 0,
        ...visible.map((x) => x.at),
      );
      if (lastActivity >= startMs) drafts.push(draft);
    });
  }
  return drafts;
}

/** Removes a dropped reviewer's reviews submitted from the dropout week on. */
function applyDropout(
  drafts: PrDraft[],
  p: Extract<Perturbation, { type: 'reviewer_dropout' }>,
  startMs: number,
): void {
  const from = startMs + (p.week - 1) * WEEK_MS;
  for (const d of drafts) {
    d.reviews = d.reviews.filter(
      (r) => !(r.author === p.login && r.at >= from),
    );
    if (d.mergedBy === p.login && d.mergedAt !== null && d.mergedAt >= from) {
      d.mergedBy = d.reviews[d.reviews.length - 1]?.author ?? d.author;
    }
  }
}

/** Reassigns reviews submitted in the week until `login` holds `share`. */
function applyConcentration(
  drafts: PrDraft[],
  p: Extract<Perturbation, { type: 'concentration' }>,
  startMs: number,
): void {
  const from = startMs + (p.week - 1) * WEEK_MS;
  const to = from + WEEK_MS;
  const inWeek = (r: ReviewDraft) => r.at >= from && r.at < to;
  const weekReviews = () =>
    drafts.flatMap((d) => d.reviews.filter(inWeek).map((r) => ({ d, r })));
  const reached = () => {
    const all = weekReviews();
    const mine = all.filter(({ r }) => r.author === p.login).length;
    return all.length === 0 || mine / all.length >= p.share;
  };

  // 1. Reassign reviews on others' PRs that `login` has not reviewed yet.
  for (const { d, r } of weekReviews()) {
    if (reached()) return;
    if (d.author === p.login || r.author === p.login) continue;
    if (d.reviews.some((x) => x.author === p.login)) continue;
    r.author = p.login;
  }
  // 2. `login` cannot review its own PRs: trim those to a single review.
  for (const d of drafts) {
    if (reached()) return;
    if (d.author !== p.login || d.reviews.length < 2) continue;
    const extra = d.reviews.findIndex(
      (r, k) => k < d.reviews.length - 1 && inWeek(r),
    );
    if (extra >= 0) d.reviews.splice(extra, 1);
  }
  // 3. Still short: second reviews by `login` on the same PR.
  for (const { d, r } of weekReviews()) {
    if (reached()) return;
    if (d.author === p.login || r.author === p.login) continue;
    r.author = p.login;
  }
}

/**
 * Issues, with the same warm-up as PRs. The first ISSUE_CLOSED_SHARE of each
 * week's issues close, each in its own stratum of the 1..10 day range.
 */
function draftIssues(
  spec: SyntheticSpec,
  rng: Rng,
  startMs: number,
  endMs: number,
): IssueDraft[] {
  const drafts: IssueDraft[] = [];
  const closing = Math.round(ISSUES_PER_WEEK * ISSUE_CLOSED_SHARE);
  let seq = 0;
  for (let w = -WARMUP_WEEKS; w < spec.weeks; w++) {
    const weekStart = startMs + w * WEEK_MS;
    const raw = Array.from({ length: ISSUES_PER_WEEK }, () => ({
      author: spec.authors[rng.int(0, spec.authors.length - 1)],
      createdU: rng.uniform(),
      delayU: rng.uniform(),
    }));
    raw.forEach((r, i) => {
      const createdAt = toMinute(
        weekStart + ((i + r.createdU) / ISSUES_PER_WEEK) * WEEK_MS,
      );
      const delay =
        (ISSUE_CLOSE_MIN_DAYS +
          ((ISSUE_CLOSE_MAX_DAYS - ISSUE_CLOSE_MIN_DAYS) * (i + r.delayU)) /
            closing) *
        DAY_MS;
      const closes = i < closing;
      const closedAt = closes ? toMinute(createdAt + delay) : null;
      const visibleClose =
        closedAt !== null && closedAt < endMs ? closedAt : null;
      seq += 1;
      if (Math.max(createdAt, visibleClose ?? 0) < startMs) return;
      drafts.push({
        kind: 'issue',
        seq,
        author: r.author,
        createdAt,
        closedAt: visibleClose,
      });
    });
  }
  return drafts;
}

function shaOf(spec: SyntheticSpec, n: number): string {
  return createHash('sha1')
    .update(`${spec.owner}/${spec.name}:${spec.seed}:${n}`)
    .digest('hex');
}

const displayName = (login: string): string =>
  login.charAt(0).toUpperCase() + login.slice(1);

function buildCommits(
  spec: SyntheticSpec,
  rng: Rng,
  prs: PrDraft[],
  startMs: number,
): Commit[] {
  const rows: Array<{ author: string; at: number }> = [];
  for (const pr of prs) {
    if (pr.mergedAt !== null && pr.mergedAt >= startMs) {
      rows.push({ author: pr.author, at: pr.mergedAt });
    }
  }
  for (let w = 0; w < spec.weeks; w++) {
    const weekStart = startMs + w * WEEK_MS;
    for (let i = 0; i < EXTRA_COMMITS_PER_WEEK; i++) {
      const author = spec.authors[rng.int(0, spec.authors.length - 1)];
      rows.push({ author, at: toMinute(weekStart + rng.uniform() * WEEK_MS) });
    }
  }
  return rows
    .map((c, n) => ({
      sha: shaOf(spec, n + 1),
      author: c.author,
      authorName: displayName(c.author),
      committedDate: iso(c.at),
      additions: rng.int(1, 300),
      deletions: rng.int(0, 150),
    }))
    .sort(
      (a, b) =>
        a.committedDate.localeCompare(b.committedDate) ||
        a.sha.localeCompare(b.sha),
    );
}

export function buildSnapshot(spec: SyntheticSpec): Snapshot {
  const rng = new Rng(spec.seed);
  const startMs = Date.parse(`${spec.start}T00:00:00.000Z`);
  const endMs = startMs + spec.weeks * WEEK_MS;
  const ps = spec.perturbations;
  const prsEnabled = !ps.some((p) => p.type === 'disable_prs');

  const prDrafts = draftPullRequests(spec, rng, startMs, endMs);
  for (const p of ps) {
    if (p.type === 'reviewer_dropout') applyDropout(prDrafts, p, startMs);
    if (p.type === 'concentration') applyConcentration(prDrafts, p, startMs);
  }
  const issueDrafts = draftIssues(spec, rng, startMs, endMs);
  const commits = buildCommits(spec, rng, prDrafts, startMs);

  // PRs and issues share one number space, in creation order.
  const numbered = [...prDrafts, ...issueDrafts].sort(
    (a, b) =>
      a.createdAt - b.createdAt ||
      a.kind.localeCompare(b.kind) ||
      a.seq - b.seq,
  );
  const numberOf = new Map<PrDraft | IssueDraft, number>();
  numbered.forEach((d, i) => numberOf.set(d, i + 1));

  const pullRequests: Pr[] = prDrafts
    .map((d): Pr => {
      const number = numberOf.get(d)!;
      const reviews = [...d.reviews].sort((a, b) => a.at - b.at);
      const lastTouch = Math.max(
        d.createdAt,
        d.closedAt ?? 0,
        ...reviews.map((r) => r.at),
      );
      return {
        githubId: `PR_${number}`,
        number,
        title: `Change ${number}`,
        author: d.author,
        mergedBy: d.mergedBy,
        state:
          d.mergedAt !== null
            ? 'MERGED'
            : d.closedAt !== null
              ? 'CLOSED'
              : 'OPEN',
        isDraft: false,
        createdAt: iso(d.createdAt),
        updatedAt: iso(lastTouch),
        mergedAt: isoOrNull(d.mergedAt),
        closedAt: isoOrNull(d.closedAt),
        additions: d.additions,
        deletions: d.deletions,
        changedFiles: d.changedFiles,
        baseRef: 'main',
        reviews: reviews.map((r): Review => ({
          githubId: '',
          author: r.author,
          state: r.state,
          submittedAt: iso(r.at),
          commentCount: 0,
        })),
      };
    })
    .sort((a, b) => a.number - b.number);
  // Review ids follow PR number order.
  let reviewSeq = 0;
  for (const pr of pullRequests) {
    for (const r of pr.reviews) r.githubId = `R_${++reviewSeq}`;
  }

  const issues: Issue[] = issueDrafts
    .map((d): Issue => {
      const number = numberOf.get(d)!;
      return {
        githubId: `I_${number}`,
        number,
        title: `Issue ${number}`,
        author: d.author,
        state: d.closedAt !== null ? 'CLOSED' : 'OPEN',
        createdAt: iso(d.createdAt),
        updatedAt: iso(d.closedAt ?? d.createdAt),
        closedAt: isoOrNull(d.closedAt),
        labels: [],
      };
    })
    .sort((a, b) => a.number - b.number);

  const logins = [...new Set([...spec.authors, ...spec.reviewers])].sort();
  const coveredTo = iso(endMs);
  return {
    version: 1,
    exportedAt: coveredTo,
    repository: {
      githubId: `R_${spec.owner}_${spec.name}`,
      owner: spec.owner,
      name: spec.name,
      defaultBranch: 'main',
      hasIssuesEnabled: prsEnabled,
      hasPullRequests: prsEnabled,
      coveredFrom: iso(startMs),
      coveredTo,
      lastSyncedAt: coveredTo,
    },
    actors: logins.map((login) => ({ login, isBot: false })),
    pullRequests: prsEnabled ? pullRequests : [],
    issues: prsEnabled ? issues : [],
    commits,
  };
}
