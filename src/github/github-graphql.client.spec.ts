import { GitHubGraphqlClient } from './github-graphql.client';
import { GitHubError } from './github.errors';

const TOKEN = 'ghp_SENTINEL_SECRET_TOKEN_123';
const NOW = new Date('2026-01-01T00:00:00Z');

function res(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function rl(remaining: number, resetAt = '2026-01-01T01:00:00Z') {
  return { cost: 1, remaining, resetAt };
}

function setup(
  queue: Array<Response | Error>,
  extra: Partial<ConstructorParameters<typeof GitHubGraphqlClient>[0]> = {},
) {
  const fetchImpl = jest.fn(() => {
    const next = queue.shift();
    if (!next) throw new Error('fetch queue empty');
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  const sleep = jest.fn((ms: number) => {
    void ms;
    return Promise.resolve();
  });
  const client = new GitHubGraphqlClient({
    token: TOKEN,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleep,
    now: () => NOW,
    random: () => 0.5, // zero jitter
    ...extra,
  });
  return { client, fetchImpl, sleep };
}

describe('GitHubGraphqlClient', () => {
  it('returns data and records rate limit', async () => {
    const { client, fetchImpl } = setup([
      res({ data: { x: 1, rateLimit: rl(4999) } }),
    ]);
    const out = await client.query<{ x: number }>('query { x }', { a: 1 });
    expect(out.x).toBe(1);
    expect(client.lastRateLimit).toEqual(rl(4999));
    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0];
    expect(url).toBe('https://api.github.com/graphql');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Authorization: `bearer ${TOKEN}`,
      'User-Agent': 'repo-pulse',
    });
    expect(JSON.parse(init.body as string)).toEqual({
      query: 'query { x }',
      variables: { a: 1 },
    });
  });

  it('retries a 502 then succeeds, with backoff via injected sleep', async () => {
    const { client, fetchImpl, sleep } = setup([
      res({}, 502),
      res({}, 429),
      res({ data: { rateLimit: rl(100) } }),
    ]);
    await client.query('q', {});
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([500, 1000]);
  });

  it('applies +-20% jitter to the backoff', async () => {
    const { client, sleep } = setup(
      [new TypeError('network'), res({ data: { rateLimit: rl(100) } })],
      { random: () => 1 },
    );
    await client.query('q', {});
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([600]);
  });

  it('retries GraphQL RATE_LIMITED errors', async () => {
    const { client, sleep } = setup([
      res({ errors: [{ type: 'RATE_LIMITED', message: 'slow down' }] }),
      res({ data: { rateLimit: rl(100) } }),
    ]);
    await client.query('q', {});
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([500]);
  });

  it('sleeps until resetAt when remaining is below the reserve before the next query', async () => {
    const resetAt = new Date(NOW.getTime() + 90_000).toISOString();
    const { client, sleep } = setup([
      res({ data: { rateLimit: rl(50, resetAt) } }),
      res({ data: { rateLimit: rl(4000) } }),
    ]);
    await client.query('q', {});
    expect(sleep).not.toHaveBeenCalled();
    await client.query('q', {});
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([91_000]);
  });

  it('never sleeps a negative duration when resetAt is in the past', async () => {
    const { client, sleep } = setup([
      res({ data: { rateLimit: rl(1, '2025-12-31T00:00:00Z') } }),
      res({ data: { rateLimit: rl(4000) } }),
    ]);
    await client.query('q', {});
    await client.query('q', {});
    expect(sleep).not.toHaveBeenCalled();
  });

  it('maps NOT_FOUND graphql error to GitHubError not_found and 401 to unauthorized', async () => {
    const { client } = setup([
      res({
        data: { repository: null, rateLimit: rl(10) },
        errors: [{ type: 'NOT_FOUND', message: 'Could not resolve' }],
      }),
      res({ message: 'Bad credentials' }, 401),
    ]);
    await expect(client.query('q', {})).rejects.toMatchObject({
      kind: 'not_found',
    });
    await expect(client.query('q', {})).rejects.toMatchObject({
      kind: 'unauthorized',
      status: 401,
    });
  });

  it('maps a 403 that is not a rate limit to forbidden, without retrying', async () => {
    const { client, fetchImpl } = setup([
      res({ message: 'Resource not accessible' }, 403),
    ]);
    await expect(client.query('q', {})).rejects.toMatchObject({
      kind: 'forbidden',
      status: 403,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('maps other graphql errors to bad_query without leaking variables', async () => {
    const { client } = setup([
      res({
        errors: [
          { type: 'X', message: 'first' },
          { type: 'Y', message: 'second' },
        ],
      }),
    ]);
    const err = await client
      .query('q', { secret: 'VARVALUE' })
      .catch((e: GitHubError) => e);
    expect(err).toMatchObject({ kind: 'bad_query' });
    expect((err as GitHubError).message).toBe('first; second');
  });

  it('throws unavailable after maxRetries failed attempts', async () => {
    const { client, fetchImpl, sleep } = setup(
      Array.from({ length: 3 }, () => res({}, 503)),
      { maxRetries: 3 },
    );
    await expect(client.query('q', {})).rejects.toMatchObject({
      kind: 'unavailable',
      status: 503,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([500, 1000]);
  });

  it('never includes the token in error messages', async () => {
    const cases: Array<Array<Response | Error>> = [
      [res({ message: `bad ${TOKEN}` }, 401)],
      [res({ message: 'nope' }, 403)],
      [new Error(`connect failed with ${TOKEN}`)],
      [res({ errors: [{ type: 'X', message: 'boom' }] })],
    ];
    for (const queue of cases) {
      const q =
        queue.length === 1 && queue[0] instanceof Error
          ? Array.from(
              { length: 2 },
              () => new Error(`connect failed with ${TOKEN}`),
            )
          : queue;
      const { client } = setup(q, { maxRetries: 2 });
      const err = await client.query('q', {}).catch((e: Error) => e);
      expect(err).toBeInstanceOf(GitHubError);
      expect((err as Error).message).not.toContain(TOKEN);
    }
  });
});
