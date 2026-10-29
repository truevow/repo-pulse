import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, resetDatabase } from './setup/db';

describe('Prisma (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  afterAll(async () => {
    await app.close();
  });

  it('persists a repository and pull request and reads them back via relations', async () => {
    const author = await prisma.actor.create({ data: { login: 'octocat' } });
    const repo = await prisma.repository.create({
      data: {
        githubId: 'R_1',
        owner: 'acme',
        name: 'widgets',
        defaultBranch: 'main',
        hasIssuesEnabled: true,
      },
    });
    await prisma.pullRequest.create({
      data: {
        repositoryId: repo.id,
        githubId: 'PR_1',
        number: 1,
        title: 'Add widget',
        authorId: author.id,
        state: 'OPEN',
        isDraft: false,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-02T00:00:00Z'),
        additions: 10,
        deletions: 2,
        changedFiles: 3,
        baseRef: 'main',
      },
    });

    const found = await prisma.repository.findUniqueOrThrow({
      where: { owner_name: { owner: 'acme', name: 'widgets' } },
      include: { pullRequests: { include: { author: true } } },
    });
    expect(found.hasPullRequests).toBe(true);
    expect(found.pullRequests).toHaveLength(1);
    expect(found.pullRequests[0]).toMatchObject({
      number: 1,
      state: 'OPEN',
      author: { login: 'octocat', isBot: false },
    });
  });

  it('starts every test from an empty database', async () => {
    expect(await prisma.repository.count()).toBe(0);
    expect(await prisma.actor.count()).toBe(0);
  });

  it('GET /api/v1/health reports the database as up', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/health')
      .expect(200);
    expect(res.body).toEqual({ status: 'ok', db: 'up' });
  });
});
