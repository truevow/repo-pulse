import type { InjectionToken } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import type { PrismaService } from '../../src/prisma/prisma.service';

/** Every application table (the @@map names); the single place to extend. */
const TABLES = [
  'repositories',
  'sync_jobs',
  'actors',
  'pull_requests',
  'reviews',
  'issues',
  'commits',
  'narratives',
] as const;

export async function resetDatabase(prisma: PrismaService): Promise<void> {
  const list = TABLES.map((t) => `"${t}"`).join(', ');
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`,
  );
}

export async function createTestApp(
  overrides: Array<{ provide: InjectionToken; useValue: unknown }> = [],
): Promise<NestExpressApplication> {
  let builder = Test.createTestingModule({ imports: [AppModule] });
  for (const o of overrides) {
    builder = builder.overrideProvider(o.provide).useValue(o.useValue);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app);
  await app.init();
  return app;
}
