import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('Errors (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/v1/nope returns a problem+json 404 with requestId', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/nope')
      .expect(404);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body).toMatchObject({
      type: 'https://repo-pulse.local/problems/not-found',
      status: 404,
      instance: '/api/v1/nope',
    });
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
  });

  it('echoes a valid x-request-id in header and body', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/nope')
      .set('x-request-id', 'abc-123')
      .expect(404);
    expect(res.headers['x-request-id']).toBe('abc-123');
    expect(res.body.requestId).toBe('abc-123');
  });

  // CR/LF cannot reach the app as a single header value (the HTTP parser
  // rejects or splits it), so the unit-level pattern covers it; here we cover
  // over-long and space-containing ids.
  it.each([
    ['200 characters long', 'a'.repeat(200)],
    ['containing a space', 'abc 123'],
    ['containing a slash', 'abc/def'],
  ])('replaces an x-request-id %s with a generated id', async (_n, value) => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/nope')
      .set('x-request-id', value)
      .expect(404);
    expect(res.headers['x-request-id']).toMatch(UUID);
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
  });
});
