import type { Snapshot } from '../../src/snapshot/snapshot.types';
import { buildSnapshot, type SyntheticSpec } from './synthetic';

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const START = '2026-08-31';
const BASE_REVIEW_H = 6;

function spec(overrides: Partial<SyntheticSpec> = {}): SyntheticSpec {
  return {
    owner: 'evalco',
    name: 'repo',
    start: START,
    weeks: 8,
    prsPerWeek: 25,
    authors: ['alice', 'bob', 'carol', 'dave'],
    reviewers: ['alice', 'bob', 'carol'],
    baseFirstReviewHours: BASE_REVIEW_H,
    baseMergeHours: 30,
    seed: 1,
    perturbations: [],
    ...overrides,
  };
}

const startMs = Date.parse(`${START}T00:00:00.000Z`);
/** 0-based week index of an ISO timestamp relative to START. */
const weekOf = (iso: string): number =>
  Math.floor((Date.parse(iso) - startMs) / WEEK_MS);

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Median first-review hours of PRs created in each week. */
function firstReviewMedianByWeek(s: Snapshot, weeks: number): number[] {
  return Array.from({ length: weeks }, (_, w) => {
    const hours = s.pullRequests
      .filter((pr) => weekOf(pr.createdAt) === w && pr.reviews.length > 0)
      .map(
        (pr) =>
          (Date.parse(pr.reviews[0].submittedAt) - Date.parse(pr.createdAt)) /
          3_600_000,
      );
    return median(hours);
  });
}

describe('buildSnapshot', () => {
  it('is deterministic for the same seed', () => {
    expect(buildSnapshot(spec({ seed: 7 }))).toEqual(
      buildSnapshot(spec({ seed: 7 })),
    );
  });

  it('differs between seeds', () => {
    expect(buildSnapshot(spec({ seed: 1 }))).not.toEqual(
      buildSnapshot(spec({ seed: 2 })),
    );
  });

  it('produces a covered, well-formed snapshot', () => {
    const s = buildSnapshot(spec());
    expect(s.repository.coveredFrom).toBe('2026-08-31T00:00:00.000Z');
    expect(s.repository.coveredTo).toBe('2026-10-26T00:00:00.000Z');
    expect(s.repository.lastSyncedAt).toBe(s.repository.coveredTo);
    expect(s.repository.hasPullRequests).toBe(true);
    expect(s.repository.hasIssuesEnabled).toBe(true);
    const from = s.repository.coveredFrom;
    const to = s.repository.coveredTo;
    const inWindow = (iso: string) => iso >= from && iso < to;
    expect(s.pullRequests.filter((p) => inWindow(p.createdAt))).toHaveLength(
      8 * 25,
    );
    expect(s.issues.filter((i) => inWindow(i.createdAt))).toHaveLength(8 * 5);
    // Warm-up items opened before the window are kept only if active in it.
    for (const pr of s.pullRequests) {
      expect(pr.createdAt < to).toBe(true);
      if (pr.createdAt < from) expect(pr.updatedAt >= from).toBe(true);
      for (const r of pr.reviews) {
        expect(r.author).not.toBe(pr.author);
        expect(r.submittedAt > pr.createdAt).toBe(true);
        expect(r.submittedAt < to).toBe(true);
      }
      if (pr.mergedAt) expect(pr.mergedAt < to).toBe(true);
    }
    for (const c of s.commits) expect(inWindow(c.committedDate)).toBe(true);
    const ids = [
      ...s.pullRequests.map((p) => p.githubId),
      ...s.pullRequests.flatMap((p) => p.reviews.map((r) => r.githubId)),
      ...s.issues.map((i) => i.githubId),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    const shas = s.commits.map((c) => c.sha);
    expect(new Set(shas).size).toBe(shas.length);
    expect(shas.every((x) => /^[0-9a-f]{40}$/.test(x))).toBe(true);
  });

  it('plants a latency spike of about the given factor in that week only', () => {
    const s = buildSnapshot(
      spec({ perturbations: [{ type: 'latency_spike', week: 6, factor: 5 }] }),
    );
    const medians = firstReviewMedianByWeek(s, 8);
    expect(medians[5]).toBeGreaterThan(5 * BASE_REVIEW_H * 0.6);
    expect(medians[5]).toBeLessThan(5 * BASE_REVIEW_H * 1.4);
    medians.forEach((m, w) => {
      if (w === 5) return;
      expect(m).toBeGreaterThan(BASE_REVIEW_H * 0.6);
      expect(m).toBeLessThan(BASE_REVIEW_H * 1.4);
    });
  });

  it('removes a dropped-out reviewer from that week on', () => {
    const s = buildSnapshot(
      spec({
        perturbations: [{ type: 'reviewer_dropout', week: 6, login: 'bob' }],
      }),
    );
    const bob = s.pullRequests
      .flatMap((pr) => pr.reviews)
      .filter((r) => r.author === 'bob');
    expect(bob.filter((r) => weekOf(r.submittedAt) >= 5)).toHaveLength(0);
    expect(bob.filter((r) => weekOf(r.submittedAt) < 5).length).toBeGreaterThan(
      0,
    );
  });

  it('concentrates the reviews of one week on one reviewer', () => {
    const s = buildSnapshot(
      spec({
        perturbations: [
          { type: 'concentration', week: 5, login: 'alice', share: 0.8 },
        ],
      }),
    );
    const week = s.pullRequests
      .flatMap((pr) => pr.reviews)
      .filter((r) => weekOf(r.submittedAt) === 4);
    const alice = week.filter((r) => r.author === 'alice').length;
    expect(week.length).toBeGreaterThanOrEqual(10);
    expect(alice / week.length).toBeGreaterThanOrEqual(0.75);
  });

  it('cuts the merged share from a week on while opened stays flat', () => {
    const s = buildSnapshot(
      spec({
        perturbations: [{ type: 'throughput_shift', fromWeek: 5, factor: 0.4 }],
      }),
    );
    const mergedByWeek = Array.from(
      { length: 8 },
      (_, w) =>
        s.pullRequests.filter(
          (pr) => weekOf(pr.createdAt) === w && pr.mergedAt !== null,
        ).length,
    );
    const before = mergedByWeek.slice(0, 4).reduce((a, b) => a + b, 0) / 4;
    // The last week's PRs may not have merged before the window closed.
    const after = mergedByWeek.slice(4, 7).reduce((a, b) => a + b, 0) / 3;
    expect(after / before).toBeGreaterThan(0.4 * 0.6);
    expect(after / before).toBeLessThan(0.4 * 1.4);
    for (let w = 0; w < 8; w++) {
      expect(
        s.pullRequests.filter((pr) => weekOf(pr.createdAt) === w),
      ).toHaveLength(25);
    }
  });

  it('yields a commits-only repository when pull requests are disabled', () => {
    const s = buildSnapshot(spec({ perturbations: [{ type: 'disable_prs' }] }));
    expect(s.pullRequests).toHaveLength(0);
    expect(s.issues).toHaveLength(0);
    expect(s.commits.length).toBeGreaterThan(0);
    expect(s.repository.hasPullRequests).toBe(false);
    expect(s.repository.hasIssuesEnabled).toBe(false);
  });
});
