import { z } from 'zod';

export const ISO_DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date (YYYY-MM-DD)');

const BOOLEAN_FLAG = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

export const InsightsQuerySchema = z.object({
  from: ISO_DATE.optional(),
  to: ISO_DATE.optional(),
  bucket: z.enum(['week', 'day']).default('week'),
  includeBots: BOOLEAN_FLAG,
});
export type InsightsQuery = z.infer<typeof InsightsQuerySchema>;
