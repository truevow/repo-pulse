import { z } from 'zod';

export const EnvSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().default(3000),
  DATABASE_URL: z.string().min(1),
  GITHUB_TOKEN: z.string().min(1).optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_MODEL: z.string().default('claude-opus-5-5'),
  ANTHROPIC_EFFORT: z.enum(['low', 'medium', 'high']).default('medium'),
  SYNC_MAX_WEEKS: z.coerce.number().int().min(1).default(26),
  NARRATIVE_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).default(10),
  CORS_ORIGIN: z.string().optional(),
  LOG_LEVEL: z.string().default('info'),
});

export type Env = z.infer<typeof EnvSchema>;

export const ENV = Symbol('ENV');

/** Parses the environment. Error messages list field names only, never values. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const fields = result.error.issues.map((i) => i.path.join('.'));
    throw new Error('Invalid environment: ' + fields.join(', '));
  }
  return result.data;
}
