import { execSync } from 'node:child_process';
import { config } from 'dotenv';
import { resolve } from 'node:path';

/** Applies migrations to the test database once before the e2e suites run. */
export default function globalSetup(): void {
  config({ path: resolve(__dirname, '../../.env.test'), quiet: true });
  const url = process.env.DATABASE_URL_TEST;
  if (!url) {
    throw new Error('DATABASE_URL_TEST is not set (see .env.test)');
  }
  execSync('npx prisma migrate deploy', {
    cwd: resolve(__dirname, '../..'),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}
