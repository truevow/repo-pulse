import { HttpException, NotFoundException } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { z } from 'zod';
import { ProblemDetailsFilter } from './problem-details.filter';
import { ProblemException } from './problem.exception';

function setup() {
  const res = {
    status: jest.fn().mockReturnThis(),
    setHeader: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  };
  const req = { id: 'req-1', originalUrl: '/api/v1/x?y=1' };
  const host = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }),
  } as unknown as ArgumentsHost;
  const logger = { error: jest.fn() };
  const filter = new ProblemDetailsFilter(logger as never);
  const body = () => res.send.mock.calls[0][0] as Record<string, unknown>;
  return { filter, host, res, logger, body };
}

describe('ProblemDetailsFilter', () => {
  it('maps a ZodError to 400 validation-error with field errors', () => {
    const { filter, host, res, body } = setup();
    const err = z.object({ owner: z.string() }).safeParse({}).error!;
    filter.catch(err, host);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(body().type).toBe(
      'https://repo-pulse.local/problems/validation-error',
    );
    expect(
      (body().errors as { fieldErrors: Record<string, unknown> }).fieldErrors
        .owner,
    ).toBeDefined();
    expect(body().requestId).toBe('req-1');
    expect(body().instance).toBe('/api/v1/x?y=1');
    expect(res.setHeader).toHaveBeenCalledWith(
      'content-type',
      'application/problem+json',
    );
  });

  it('maps an unknown error to 500 internal without leaking the message', () => {
    const { filter, host, res, logger, body } = setup();
    filter.catch(new Error('db password is hunter2'), host);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(body().detail).toBe('Unexpected error');
    expect(body().title).toBe('Internal Server Error');
    expect(JSON.stringify(body())).not.toContain('hunter2');
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'req-1' }),
      expect.any(String),
    );
  });

  it('maps HttpException(404) to not-found', () => {
    const { filter, host, res, body } = setup();
    filter.catch(new NotFoundException('Cannot GET /nope'), host);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(body().type).toMatch(/\/not-found$/);
    expect(body().detail).toBe('Cannot GET /nope');
  });

  it('maps HttpException(409) to conflict', () => {
    const { filter, host, body } = setup();
    filter.catch(new HttpException('busy', 409), host);
    expect(body().type).toMatch(/\/conflict$/);
  });

  it('maps ThrottlerException to 429 rate-limited with Retry-After', () => {
    const { filter, host, res, body } = setup();
    filter.catch(new ThrottlerException(), host);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(body().type).toMatch(/\/rate-limited$/);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '60');
  });

  it('renders a ProblemException with extensions and headers', () => {
    const { filter, host, res, body } = setup();
    filter.catch(
      new ProblemException({
        status: 409,
        type: 'repo-not-synced',
        title: 'Repo not synced',
        detail: 'Sync first',
        extensions: { owner: 'a' },
        headers: { 'X-Foo': 'bar' },
      }),
      host,
    );
    expect(res.status).toHaveBeenCalledWith(409);
    expect(body()).toMatchObject({
      title: 'Repo not synced',
      detail: 'Sync first',
      owner: 'a',
      status: 409,
    });
    expect(res.setHeader).toHaveBeenCalledWith('X-Foo', 'bar');
  });
});
