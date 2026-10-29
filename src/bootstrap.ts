import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { ProblemDetailsFilter } from './common/problem-details.filter';
import { ENV, type Env } from './config/env';

/** Strict policy for the demo page and the API: same-origin code only. */
const STRICT_CSP = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'"],
  imgSrc: ["'self'", 'data:'],
  connectSrc: ["'self'"],
  // Plain-http localhost must keep working (no forced https upgrade).
  upgradeInsecureRequests: null,
};

/** Swagger UI ships an inline <style> block; scripts stay same-origin. */
const DOCS_CSP = { ...STRICT_CSP, styleSrc: ["'self'", "'unsafe-inline'"] };

const strictHelmet = helmet({
  contentSecurityPolicy: { directives: STRICT_CSP },
});
const docsHelmet = helmet({ contentSecurityPolicy: { directives: DOCS_CSP } });

function securityHeaders(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const isDocs = req.path === '/docs' || req.path.startsWith('/docs/');
  (isDocs ? docsHelmet : strictHelmet)(req, res, next);
}

/** HTTP-level setup shared by main.ts and the e2e tests. */
export function configureApp(app: NestExpressApplication): void {
  const env = app.get<Env>(ENV);
  app.use(securityHeaders);
  // Served from the working directory, not dist/: `nest build` copies nothing.
  // Registered before any route, so `/`, `/app.js`, `/styles.css` bypass the prefix.
  app.useStaticAssets(join(process.cwd(), 'public'));
  app.useGlobalFilters(new ProblemDetailsFilter(app.get(Logger)));
  app.setGlobalPrefix('api/v1', { exclude: ['docs'] });
  if (env.CORS_ORIGIN) {
    app.enableCors({ origin: env.CORS_ORIGIN.split(',').map((o) => o.trim()) });
  }
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle('Repo Pulse').setVersion('1.0').build(),
  );
  SwaggerModule.setup('docs', app, document);
}
