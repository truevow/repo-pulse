import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup/db';

describe('Health (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/v1/health returns ok with a request id header', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/health')
      .expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.headers['x-request-id']).toMatch(/^[A-Za-z0-9._-]{1,128}$/);
  });
});
