import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(__dirname, '../../.env.test'), quiet: true });
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= process.env.DATABASE_URL_TEST;
process.env.LOG_LEVEL ??= 'silent';
