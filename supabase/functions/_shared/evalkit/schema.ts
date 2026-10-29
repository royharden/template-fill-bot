import { z } from 'zod';
import { FIELD_KEYS } from '../content/types.ts';
import type { GoldScenario } from './types.ts';

const key = z.enum(FIELD_KEYS);
const label = z.object({ state: z.enum(['valid', 'missing', 'ambiguous', 'conflict', 'invalid', 'none_confirmed']), value: z.union([z.string(), z.number().finite(), z.array(z.string())]).optional() }).strict()
  .refine((value) => value.state !== 'valid' || value.value !== undefined, 'valid_label_requires_value');
const fields = Object.fromEntries(FIELD_KEYS.map((name) => [name, label])) as Record<(typeof FIELD_KEYS)[number], typeof label>;
export const GoldScenarioSchema = z.object({ version: z.literal(1), id: z.string().regex(/^[a-z0-9-]+$/), base_id: z.string().regex(/^[a-z0-9-]+$/), stratum: z.string().min(1),
  origin: z.enum(['generated', 'handtrap']), author: z.string().min(1), licence: z.literal('MIT'),
  messages: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/).optional(), text: z.string().min(1) }).strict()).min(1).max(12),
  expected: z.object({ fields: z.object(fields).strict(), required_questions: z.array(key), optional_confirmation: z.boolean(), clause_ids: z.array(z.string()).nullable(), unsupported_quotes: z.array(z.string()), render_blocked: z.boolean() }).strict(),
  tags: z.array(z.string().min(1)).min(1), security: z.enum(['stale_approval', 'expiry_retry_budget', 'docx_hidden']).optional(),
}).strict();
export function parseGoldScenario(value: unknown): GoldScenario { return GoldScenarioSchema.parse(value); }
