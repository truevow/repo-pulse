import { z } from 'zod';

/**
 * The model's structured output. Kept free of records, object unions,
 * defaults and transforms so it converts to a strict JSON schema.
 */
export const EvidenceSchema = z
  .object({
    signal_id: z.string().nullable(),
    metric: z.string(),
    bucket: z.string().nullable(),
    entity: z.string().nullable(),
    value: z.number(),
    note: z.string(),
  })
  .strict();

export const HypothesisSchema = z
  .object({
    statement: z.string(),
    confidence: z.number().min(0).max(1),
    evidence: z.array(EvidenceSchema).min(1).max(8),
    alternative_explanations: z.array(z.string()).max(4),
    suggested_check: z.string(),
  })
  .strict();

export const SynthesisOutputSchema = z
  .object({
    headline: z.string(),
    narrative: z.string(),
    hypotheses: z.array(HypothesisSchema).max(3),
    data_caveats: z.array(z.string()).max(6),
  })
  .strict();

export type Evidence = z.infer<typeof EvidenceSchema>;
export type Hypothesis = z.infer<typeof HypothesisSchema>;
export type SynthesisOutput = z.infer<typeof SynthesisOutputSchema>;
