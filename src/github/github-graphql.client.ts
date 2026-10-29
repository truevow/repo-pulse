import type { PinoLogger } from 'nestjs-pino';
import type { GitHubClient } from './github.client';
import { GitHubError } from './github.errors';
import type { RateLimit } from './github.types';

const ENDPOINT = 'https://api.github.com/graphql';
const BASE_DELAY_MS = 500;
const JITTER = 0.2;
const MAX_RETRY_AFTER_MS = 120_000;
/** Longest wait for a known rate-limit reset (GitHub's window is one hour). */
const MAX_RESET_WAIT_MS = 3_600_000;
const MIN_RESET_WAIT_MS = 1000;

export interface GitHubGraphqlClientOptions {
  token: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** Sleep until the window resets when fewer than this many points remain. */
  rateLimitReserve?: number;
  maxRetries?: number;
  /** Returns [0,1); injectable so tests can assert exact delays. */
  random?: () => number;
  logger?: PinoLogger;
}

interface GraphqlError {
  type?: string;
  message?: string;
}

interface GraphqlBody {
  data?: (Record<string, unknown> & { rateLimit?: RateLimit }) | null;
  errors?: GraphqlError[];
  message?: string;
}

/** Marks a failed attempt that is worth retrying. */
class Retryable {
  constructor(
    readonly reason: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
    /** retryAfterMs waits out the rate-limit window, so skip the reserve wait. */
    readonly untilReset = false,
  ) {}
}

export class GitHubGraphqlClient implements GitHubClient {
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly reserve: number;
  private readonly maxRetries: number;
  private readonly random: () => number;
  private readonly logger?: PinoLogger;
  private rateLimit: RateLimit | null = null;

  constructor(opts: GitHubGraphqlClientOptions) {
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
    this.sleep =
      opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = opts.now ?? (() => new Date());
    this.reserve = opts.rateLimitReserve ?? 100;
    this.maxRetries = opts.maxRetries ?? 5;
    this.random = opts.random ?? Math.random;
    this.logger = opts.logger;
  }

  get lastRateLimit(): RateLimit | null {
    return this.rateLimit;
  }

  async query<T>(
    document: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    let last: Retryable = new Retryable('no attempt made');
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      if (!last.untilReset) await this.waitForRateLimitWindow();
      const outcome = await this.attempt<T>(document, variables);
      if (!(outcome instanceof Retryable)) return outcome.value;
      last = outcome;
      if (attempt < this.maxRetries - 1) {
        await this.sleep(last.retryAfterMs ?? this.backoffMs(attempt));
      }
    }
    throw new GitHubError(
      'unavailable',
      `GitHub unavailable after ${this.maxRetries} attempts: ${last.reason}`,
      last.status,
    );
  }

  private async waitForRateLimitWindow(): Promise<void> {
    const rl = this.rateLimit;
    if (!rl || rl.remaining >= this.reserve) return;
    const ms = Date.parse(rl.resetAt) + 1000 - this.now().getTime();
    if (ms > 0) await this.sleep(ms);
  }

  private backoffMs(attempt: number): number {
    const base = BASE_DELAY_MS * 2 ** attempt;
    return Math.round(base * (1 + (this.random() * 2 - 1) * JITTER));
  }

  /** One HTTP round trip: returns data, a Retryable, or throws a final GitHubError. */
  private async attempt<T>(
    document: string,
    variables: Record<string, unknown>,
  ): Promise<{ value: T } | Retryable> {
    let response: Response;
    try {
      response = await this.fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `bearer ${this.token}`,
          'User-Agent': 'repo-pulse',
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: document, variables }),
      });
    } catch {
      return new Retryable('network error');
    }

    const body = await this.readBody(response);
    const status = response.status;
    if (status === 401) {
      throw new GitHubError('unauthorized', 'GitHub rejected credentials', 401);
    }
    if (status === 429 || status === 403) {
      if (status === 403 && !this.isRateLimited403(response, body)) {
        throw new GitHubError('forbidden', 'GitHub access forbidden', 403);
      }
      return this.rateLimited(
        status === 429 ? 'HTTP 429' : 'rate limited',
        status,
        response,
      );
    }
    if (status >= 500) {
      return new Retryable(
        `HTTP ${status}`,
        status,
        this.retryAfterMs(response),
      );
    }
    if (status < 200 || status >= 300) {
      throw new GitHubError('bad_query', `Unexpected HTTP ${status}`, status);
    }
    return this.interpret<T>(body, status, response);
  }

  /**
   * A rate-limited attempt: honour `retry-after`; else, when no points are
   * left, wait for the known reset; else (a secondary limit with points
   * left) fall back to exponential backoff. `graphql` carries the body's
   * rateLimit for a GraphQL RATE_LIMITED error; a missing `remaining` there
   * counts as exhausted.
   */
  private rateLimited(
    reason: string,
    status: number,
    response: Response,
    graphql?: { rateLimit?: RateLimit },
  ): Retryable {
    const retryAfter = this.retryAfterMs(response);
    if (retryAfter !== undefined)
      return new Retryable(reason, status, retryAfter);
    const remaining = graphql?.rateLimit?.remaining;
    const exhausted =
      response.headers.get('x-ratelimit-remaining') === '0' ||
      (graphql !== undefined && (remaining === undefined || remaining === 0));
    const untilReset = exhausted
      ? this.resetWaitMs(response, graphql?.rateLimit?.resetAt)
      : undefined;
    return untilReset === undefined
      ? new Retryable(reason, status)
      : new Retryable(reason, status, untilReset, true);
  }

  /** Ms until the known reset plus 1 s, capped at 1 h; undefined when unknown. */
  private resetWaitMs(
    response: Response,
    resetAt?: string,
  ): number | undefined {
    let resetMs = resetAt === undefined ? NaN : Date.parse(resetAt);
    const header = response.headers.get('x-ratelimit-reset');
    if (!Number.isFinite(resetMs) && header) resetMs = Number(header) * 1000;
    if (!Number.isFinite(resetMs) || resetMs <= 0) return undefined;
    const ms = resetMs + 1000 - this.now().getTime();
    return Math.min(Math.max(ms, MIN_RESET_WAIT_MS), MAX_RESET_WAIT_MS);
  }

  private interpret<T>(
    body: GraphqlBody,
    status: number,
    response: Response,
  ): { value: T } | Retryable {
    const rl = body.data?.rateLimit;
    if (rl) {
      this.rateLimit = rl;
      this.logger?.debug(
        { cost: rl.cost, remaining: rl.remaining, resetAt: rl.resetAt },
        'github graphql request',
      );
    }
    const errors = body.errors ?? [];
    if (errors.length === 0) {
      if (!body.data || typeof body.data !== 'object') {
        return new Retryable('response had no usable data', status);
      }
      return { value: body.data as T };
    }
    if (errors.some((e) => e.type === 'RATE_LIMITED')) {
      return this.rateLimited('rate limited', status, response, {
        rateLimit: rl,
      });
    }
    if (errors.every((e) => e.type === 'NOT_FOUND')) {
      throw new GitHubError('not_found', 'GitHub resource not found', status);
    }
    const message = errors
      .map((e) => e.message ?? 'unknown error')
      .join('; ')
      .split(this.token)
      .join('[redacted]');
    throw new GitHubError('bad_query', message, status);
  }

  /** Honours a `retry-after` header (seconds), capped at 120 s. */
  private retryAfterMs(response: Response): number | undefined {
    const seconds = Number(response.headers.get('retry-after'));
    if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }

  private isRateLimited403(response: Response, body: GraphqlBody): boolean {
    if (response.headers.get('x-ratelimit-remaining') === '0') return true;
    if (response.headers.get('retry-after')) return true;
    return /rate limit/i.test(body.message ?? '');
  }

  private async readBody(response: Response): Promise<GraphqlBody> {
    try {
      return (await response.json()) as GraphqlBody;
    } catch {
      return {};
    }
  }
}
