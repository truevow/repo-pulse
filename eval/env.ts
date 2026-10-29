import { config } from 'dotenv';
import { resolve } from 'node:path';

/**
 * Imported first by run.ts. Loads `.env` (the Anthropic key) and `.env.test`
 * (the eval database), then points DATABASE_URL at the test database so the
 * suite never truncates the development data. Values are never printed.
 */
const root = resolve(__dirname, '..');
config({ path: resolve(root, '.env'), quiet: true });
config({ path: resolve(root, '.env.test'), quiet: true });

if (!process.env.DATABASE_URL_TEST) {
  throw new Error('DATABASE_URL_TEST is not set (see .env.test)');
}
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL ??= 'silent';
