import {
  Catch,
  HttpException,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import type { Logger } from 'nestjs-pino';
import { z, ZodError } from 'zod';
import { ProblemException, type ProblemInit } from './problem.exception';

const TYPE_BASE = 'https://repo-pulse.local/problems/';

type LogSink = Pick<Logger, 'error'>;

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  constructor(private readonly logger: LogSink) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request & { id?: string }>();
    const res = http.getResponse<Response>();
    const requestId = req.id;

    const problem = this.toProblem(exception, requestId);
    const { status, type, title, detail, extensions, headers } = problem;

    res.status(status);
    res.setHeader('content-type', 'application/problem+json');
    for (const [name, value] of Object.entries(headers ?? {})) {
      res.setHeader(name, value);
    }
    res.send({
      type: TYPE_BASE + type,
      title,
      status,
      ...(detail !== undefined && { detail }),
      instance: req.originalUrl,
      requestId,
      ...extensions,
    });
  }

  private toProblem(exception: unknown, requestId?: string): ProblemInit {
    if (exception instanceof ProblemException) return exception.problem;

    if (exception instanceof ZodError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        type: 'validation-error',
        title: 'Bad Request',
        detail: 'Request validation failed',
        extensions: { errors: z.flattenError(exception) },
      };
    }

    if (exception instanceof ThrottlerException) {
      return {
        status: HttpStatus.TOO_MANY_REQUESTS,
        type: 'rate-limited',
        title: 'Too Many Requests',
        detail: exception.message,
        headers: { 'Retry-After': '60' },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        status,
        type: this.typeFor(status),
        title: HttpStatus[status] ? titleCase(HttpStatus[status]) : 'Error',
        detail: exception.message,
      };
    }

    this.logger.error({ err: exception, requestId }, 'Unhandled exception');
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      type: 'internal',
      title: 'Internal Server Error',
      detail: 'Unexpected error',
    };
  }

  /** Any status without a dedicated type is `internal`, with its real status. */
  private typeFor(status: number): ProblemInit['type'] {
    if (status === 400 || status === 422) return 'validation-error';
    if (status === 404) return 'not-found';
    if (status === 409) return 'conflict';
    if (status === 429) return 'rate-limited';
    return 'internal';
  }
}

function titleCase(name: string): string {
  return name
    .toLowerCase()
    .split('_')
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}
