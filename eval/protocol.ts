import { z } from 'zod';
export const ProtocolSchema = z.object({
  version: z.literal(1), seed: z.number().int(), bootstrap_iterations: z.number().int().min(100).max(10000),
  methods: z.array(z.enum(['regex', 'llm', 'jev', 'free_draft_blind', 'free_draft_library', 'mock'])).min(1),
  llm_provider: z.enum(['anthropic', 'openai_compatible']), llm_model: z.string().min(1).max(128), jev_model: z.string().min(1).max(128),
  max_output_tokens: z.number().int().min(1).max(32000), timeout_ms: z.number().int().min(1).max(120000), retries: z.union([z.literal(0), z.literal(1)]),
  option_order_seed: z.number().int(), thresholds: z.object({ jev_default: z.literal(false), wrong_fill_nonincrease_both_baselines: z.literal(true) }).strict(), note: z.string(),
}).strict();
export type Protocol = z.infer<typeof ProtocolSchema>;
