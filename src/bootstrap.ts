import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { ENV, type Env } from './config/env';

/** HTTP-level setup shared by main.ts and the e2e tests. */
export function configureApp(app: INestApplication): void {
  const env = app.get<Env>(ENV);
  app.use(helmet());
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
