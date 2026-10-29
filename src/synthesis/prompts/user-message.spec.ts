import type { InsightsResponse } from '../../signals/insights.types';
import { METRIC_NAMES } from '../../signals/metric-names';
import {
  CONCENTRATION_SIGNAL,
  INSIGHTS_FIXTURE,
  LEVEL_SHIFT_SIGNAL,
  OUTLIER_SIGNAL,
} from '../../../test/fixtures/insights.fixture';
import { buildUserMessage } from './user-message';

const withPartialLastBucket = (): InsightsResponse => ({
  ...INSIGHTS_FIXTURE,
  buckets: INSIGHTS_FIXTURE.buckets.map((b, i) =>
    i === INSIGHTS_FIXTURE.buckets.length - 1 ? { ...b, partial: true } : b,
  ),
});

describe('buildUserMessage', () => {
  it('has every section, in order', () => {
    const msg = buildUserMessage(INSIGHTS_FIXTURE);
    const sections = [
      'REPOSITORY',
      'WINDOW',
      'AVAILABILITY/COVERAGE',
      'METRICS (CSV)',
      'LEADERBOARDS',
      'SIGNALS',
      'METRIC DEFINITIONS',
      'TOOLS',
    ].map((s) => msg.indexOf(`\n${s}`));
    expect(sections.every((i) => i > 0)).toBe(true);
    expect([...sections].sort((a, b) => a - b)).toEqual(sections);
  });

  it('writes one CSV row per bucket, - for null and * on partial keys', () => {
    const lines = buildUserMessage(withPartialLastBucket()).split('\n');
    const header = lines.indexOf(`bucket,${METRIC_NAMES.join(',')}`);
    expect(header).toBeGreaterThan(0);
    const [w1, w2] = lines.slice(header + 1, header + 3);
    expect(w1.startsWith('2026-08-31,')).toBe(true);
    expect(w2.startsWith('2026-09-07*,')).toBe(true);
    const cells = w1.split(',');
    expect(cells[1 + METRIC_NAMES.indexOf('prs_merged')]).toBe('10');
    expect(cells[1 + METRIC_NAMES.indexOf('bus_factor_50')]).toBe('-');
  });

  it('renders a bucket outside the synced range with ! and - in every cell', () => {
    const msg = buildUserMessage({
      ...INSIGHTS_FIXTURE,
      buckets: INSIGHTS_FIXTURE.buckets.map((b, i) =>
        i === 0 ? { ...b, covered: false } : b,
      ),
    });
    const lines = msg.split('\n');
    const header = lines.indexOf(`bucket,${METRIC_NAMES.join(',')}`);
    const [w1, w2] = lines.slice(header + 1, header + 3);
    expect(w1).toBe(['2026-08-31!', ...METRIC_NAMES.map(() => '-')].join(','));
    expect(w2.startsWith('2026-09-07,')).toBe(true);
    expect(msg).toContain('! marks a bucket outside the synced range');
  });

  it('includes signal ids and examples as JSON, and leaderboards with ledger names', () => {
    const msg = buildUserMessage(INSIGHTS_FIXTURE);
    expect(msg).toContain(`"id": "${OUTLIER_SIGNAL.id}"`);
    expect(msg).toContain('"ref": "#123"');
    expect(msg).toContain(
      'contributors: login,merged_prs,commits,lines_changed',
    );
    expect(msg).toContain('Alice,7,25,1200');
    expect(msg).toContain('mergers: login,prs_merged_by');
  });

  it('lists high-severity signals first, otherwise in detector order', () => {
    const msg = buildUserMessage(INSIGHTS_FIXTURE);
    const at = (id: string) => msg.indexOf(`"id": "${id}"`);
    expect(at(OUTLIER_SIGNAL.id)).toBeLessThan(at(LEVEL_SHIFT_SIGNAL.id));
    expect(at(LEVEL_SHIFT_SIGNAL.id)).toBeLessThan(at(CONCENTRATION_SIGNAL.id));
  });

  it('keeps only the top 10 of each leaderboard', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      login: `user${i}`,
      reviews: 20 - i,
      approvals: 0,
    }));
    const msg = buildUserMessage({
      ...INSIGHTS_FIXTURE,
      leaderboards: { ...INSIGHTS_FIXTURE.leaderboards, reviewers: many },
    });
    expect(msg).toContain('user9,11,0');
    expect(msg).not.toContain('user10,');
  });

  it('is deterministic for equal input', () => {
    expect(buildUserMessage(structuredClone(INSIGHTS_FIXTURE))).toBe(
      buildUserMessage(INSIGHTS_FIXTURE),
    );
  });
});
