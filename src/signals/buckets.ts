import { ProblemException } from '../common/problem.exception';

export type BucketSize = 'week' | 'day';

/** Half-open `[from, to)` range; both ends are UTC midnight. */
export interface Window {
  from: Date;
  to: Date;
}

export interface BucketSpec {
  key: string;
  start: Date;
  end: Date;
  partial: boolean;
  coveredDays: number;
}

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const DEFAULT_WEEKS = 8;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function startOfUtcDay(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
}

/** Monday 00:00 UTC at or before `d`. */
function startOfIsoWeek(d: Date): Date {
  const day = startOfUtcDay(d);
  const sinceMonday = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - sinceMonday * DAY_MS);
}

function bucketStart(d: Date, size: BucketSize): Date {
  return size === 'week' ? startOfIsoWeek(d) : startOfUtcDay(d);
}

function bucketLengthMs(size: BucketSize): number {
  return size === 'week' ? WEEK_MS : DAY_MS;
}

export function bucketKey(d: Date, size: BucketSize): string {
  return formatDate(bucketStart(d, size));
}

export function defaultWindow(now: Date, weeks = DEFAULT_WEEKS): Window {
  const to = startOfIsoWeek(now);
  return { from: new Date(to.getTime() - weeks * WEEK_MS), to };
}

function invalid(detail: string): ProblemException {
  return new ProblemException({
    status: 400,
    type: 'validation-error',
    title: 'Bad Request',
    detail,
  });
}

function parseDate(name: string, value: string): Date {
  const date = new Date(`${value}T00:00:00Z`);
  if (
    !ISO_DATE.test(value) ||
    Number.isNaN(date.getTime()) ||
    formatDate(date) !== value
  ) {
    throw invalid(`${name} must be an ISO date (YYYY-MM-DD)`);
  }
  return date;
}

export function parseWindow(
  q: { from?: string; to?: string },
  now: Date,
  maxWeeks: number,
): Window {
  const from = q.from === undefined ? undefined : parseDate('from', q.from);
  const to = q.to === undefined ? undefined : parseDate('to', q.to);
  const fallback = defaultWindow(now);

  const resolvedTo = to ?? fallback.to;
  const resolvedFrom =
    from ??
    (to ? new Date(to.getTime() - DEFAULT_WEEKS * WEEK_MS) : fallback.from);

  if (resolvedFrom.getTime() >= resolvedTo.getTime()) {
    throw invalid('from must be before to');
  }
  if (resolvedTo.getTime() - resolvedFrom.getTime() > maxWeeks * WEEK_MS) {
    throw invalid(`window must not exceed ${maxWeeks} weeks`);
  }
  if (resolvedTo.getTime() > startOfUtcDay(now).getTime() + DAY_MS) {
    throw invalid('to must not be in the future');
  }
  return { from: resolvedFrom, to: resolvedTo };
}

export function buildBuckets(window: Window, size: BucketSize): BucketSpec[] {
  const length = bucketLengthMs(size);
  const buckets: BucketSpec[] = [];
  for (
    let start = bucketStart(window.from, size).getTime();
    start < window.to.getTime();
    start += length
  ) {
    const end = start + length;
    const coveredStart = Math.max(start, window.from.getTime());
    const coveredEnd = Math.min(end, window.to.getTime());
    buckets.push({
      key: formatDate(new Date(start)),
      start: new Date(start),
      end: new Date(end),
      partial: coveredStart > start || coveredEnd < end,
      coveredDays: Math.round((coveredEnd - coveredStart) / DAY_MS),
    });
  }
  return buckets;
}
