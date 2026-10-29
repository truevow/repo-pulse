import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup/db';

describe('Static demo page (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET / serves index.html with a strict script CSP', async () => {
    const res = await request(app.getHttpServer()).get('/').expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.text).toContain('<title>Repo Pulse</title>');
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).not.toContain('upgrade-insecure-requests');
  });

  it('GET /app.js serves JavaScript', async () => {
    const res = await request(app.getHttpServer()).get('/app.js').expect(200);
    expect(res.headers['content-type']).toMatch(
      /^(application|text)\/javascript/,
    );
  });

  it('GET /styles.css serves CSS', async () => {
    const res = await request(app.getHttpServer())
      .get('/styles.css')
      .expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/css/);
  });

  it('GET /docs still serves Swagger UI', async () => {
    const res = await request(app.getHttpServer()).get('/docs').expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.headers['content-security-policy']).not.toContain(
      'upgrade-insecure-requests',
    );
  });

  it('GET /api/v1/health still works', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/health')
      .expect(200);
    expect(res.body.status).toBe('ok');
  });

  it('unknown API routes still return problem details', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/nope')
      .expect(404);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
  });
});
