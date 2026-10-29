import { ProblemException } from '../common/problem.exception';
import {
  bucketKey,
  buildBuckets,
  defaultWindow,
  formatDate,
  parseWindow,
} from './buckets';

const d = (s: string): Date => new Date(`${s}T00:00:00Z`);

describe('defaultWindow', () => {
  it('ends at the most recent Monday and spans 8 full weeks', () => {
    const w = defaultWindow(new Date('2026-10-28T15:00:00Z'));
    expect(formatDate(w.to)).toBe('2026-10-26');
    expect(formatDate(w.from)).toBe('2026-08-31');
  });

  it('a Monday at 00:00 counts as the boundary itself', () => {
    expect(formatDate(defaultWindow(new Date('2026-10-26T00:00:00Z')).to)).toBe(
      '2026-10-26',
    );
  });

  it('a Sunday resolves to the Monday six days earlier', () => {
    expect(formatDate(defaultWindow(new Date('2026-11-01T23:59:59Z')).to)).toBe(
      '2026-10-26',
    );
  });

  it('honours a custom number of weeks', () => {
    const w = defaultWindow(new Date('2026-10-28T15:00:00Z'), 2);
    expect(formatDate(w.from)).toBe('2026-10-12');
  });
});

describe('buildBuckets', () => {
  it('marks edge buckets partial with covered day counts', () => {
    const b = buildBuckets(
      { from: d('2026-09-03'), to: d('2026-09-21') },
      'week',
    );
    expect(b.map((x) => x.key)).toEqual([
      '2026-08-31',
      '2026-09-07',
      '2026-09-14',
    ]);
    expect(b[0]).toMatchObject({ partial: true, coveredDays: 4 });
    expect(b[1]).toMatchObject({ partial: false, coveredDays: 7 });
    expect(b[2]).toMatchObject({ partial: false, coveredDays: 7 });
    expect(b[0].start).toEqual(d('2026-08-31'));
    expect(b[0].end).toEqual(d('2026-09-07'));
  });

  it('a Monday-aligned window yields full buckets', () => {
    const b = buildBuckets(
      { from: d('2026-08-31'), to: d('2026-09-14') },
      'week',
    );
    expect(b.map((x) => [x.key, x.partial, x.coveredDays])).toEqual([
      ['2026-08-31', false, 7],
      ['2026-09-07', false, 7],
    ]);
  });

  it('a window inside one week gives a single partial bucket', () => {
    const b = buildBuckets(
      { from: d('2026-09-01'), to: d('2026-09-04') },
      'week',
    );
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({
      key: '2026-08-31',
      partial: true,
      coveredDays: 3,
    });
  });

  it('day buckets are one per day and never partial', () => {
    const b = buildBuckets(
      { from: d('2026-09-03'), to: d('2026-09-06') },
      'day',
    );
    expect(b.map((x) => x.key)).toEqual([
      '2026-09-03',
      '2026-09-04',
      '2026-09-05',
    ]);
    expect(b.every((x) => !x.partial && x.coveredDays === 1)).toBe(true);
  });
});

describe('bucketKey', () => {
  it('maps any instant to its Monday or its day', () => {
    const t = new Date('2026-09-06T23:59:59Z');
    expect(bucketKey(t, 'week')).toBe('2026-08-31');
    expect(bucketKey(t, 'day')).toBe('2026-09-06');
    expect(bucketKey(new Date('2026-09-07T00:00:00Z'), 'week')).toBe(
      '2026-09-07',
    );
  });
});

describe('parseWindow', () => {
  const now = new Date('2026-10-28T00:00:00Z');

  it('rejects from >= to, windows over maxWeeks, and bad dates', () => {
    expect(() =>
      parseWindow({ from: '2026-10-10', to: '2026-10-01' }, now, 26),
    ).toThrow(ProblemException);
    expect(() =>
      parseWindow({ from: '2026-10-10', to: '2026-10-10' }, now, 26),
    ).toThrow(/before/);
    expect(() =>
      parseWindow({ from: '2026-01-01', to: '2026-10-01' }, now, 26),
    ).toThrow(/26 weeks/);
    expect(() => parseWindow({ from: '2026-13-01' }, now, 26)).toThrow(
      ProblemException,
    );
    expect(() => parseWindow({ from: '2026-02-30' }, now, 26)).toThrow(
      /ISO date/,
    );
    expect(() => parseWindow({ to: '10/01/2026' }, now, 26)).toThrow(
      /ISO date/,
    );
  });

  it('throws a 400 validation-error problem', () => {
    try {
      parseWindow({ from: 'nope' }, now, 26);
      throw new Error('expected throw');
    } catch (e) {
      expect((e as ProblemException).problem).toMatchObject({
        status: 400,
        type: 'validation-error',
        title: 'Bad Request',
      });
    }
  });

  it('rejects a to later than tomorrow midnight', () => {
    expect(() =>
      parseWindow({ from: '2026-10-01', to: '2026-10-30' }, now, 26),
    ).toThrow(/future/);
    expect(
      parseWindow({ from: '2026-10-01', to: '2026-10-29' }, now, 26).to,
    ).toEqual(d('2026-10-29'));
  });

  it('defaults each missing side from defaultWindow', () => {
    const fromOnly = parseWindow({ from: '2026-09-01' }, now, 26);
    expect(formatDate(fromOnly.from)).toBe('2026-09-01');
    expect(formatDate(fromOnly.to)).toBe('2026-10-26');
    const toOnly = parseWindow({ to: '2026-10-19' }, now, 26);
    expect(formatDate(toOnly.from)).toBe('2026-08-24');
    expect(formatDate(toOnly.to)).toBe('2026-10-19');
    const neither = parseWindow({}, now, 26);
    expect(formatDate(neither.from)).toBe('2026-08-31');
    expect(formatDate(neither.to)).toBe('2026-10-26');
  });

  it('accepts a window of exactly maxWeeks', () => {
    const w = parseWindow({ from: '2026-04-27', to: '2026-10-26' }, now, 26);
    expect(formatDate(w.from)).toBe('2026-04-27');
  });
});

describe('buildBuckets trailing edge', () => {
  it('marks a last bucket partial when the window ends mid-week', () => {
    const b = buildBuckets(
      { from: d('2026-09-07'), to: d('2026-09-12') },
      'week',
    );
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ partial: true, coveredDays: 5 });
  });
});
