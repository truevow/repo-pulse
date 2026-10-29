import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Params } from 'nestjs-pino';
import type { Env } from './env';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export function buildLoggerOptions(env: Env): Params {
  return {
    pinoHttp: {
      level: env.LOG_LEVEL,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers["x-api-key"]',
          'req.headers.cookie',
        ],
        censor: '[redacted]',
      },
      genReqId: (req: IncomingMessage, res: ServerResponse) => {
        const header = req.headers['x-request-id'];
        const candidate = Array.isArray(header) ? header[0] : header;
        const id =
          candidate && REQUEST_ID_PATTERN.test(candidate)
            ? candidate
            : randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      customProps: (req: IncomingMessage) => ({
        requestId: (req as IncomingMessage & { id?: string }).id,
      }),
      transport:
        env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
    },
  };
}
