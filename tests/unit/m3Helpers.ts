// Shared helpers for the M3 unit tests (not a test file itself). Written in Dirty Mode; not yet run (DV-TESTS).
// Tests that need a SUCCESSFUL render compute a lock in-test (TEST_LOCK) because the committed lock is the
// UNLOCKED sentinel until DV-LOCK.
import { readFileSync } from 'node:fs';
import {
  FIELD_SPECS,
  LIBRARY_CONTENT,
  applyAnswer,
  computeLock,
  createMockExtractor,
  findAllCandidates,
  groundFields,
  normaliseIntake,
  runExtraction,
} from '../../supabase/functions/_shared/fillkit/index.ts';
import type {
  ExtractorMethod,
  FieldProposal,
  FieldValue,
  GroundedField,
  GroundingResult,
  Intake,
  MatterState,
  MockFixture,
} from '../../supabase/functions/_shared/fillkit/index.ts';
import type { FieldKey } from '../../supabase/functions/_shared/content/types.ts';

export const TEST_LOCK = computeLock(LIBRARY_CONTENT);

export interface NotIncludedExpect {
  readonly reason: string;
  readonly clause_id: string | null;
  readonly quote: string;
  readonly pointer: string;
}

export interface ScenarioFixture extends MockFixture {
  readonly messages: { readonly id: string; readonly text: string }[];
  readonly expected: Record<string, unknown>;
}

export interface DemoFixture extends MockFixture {
  readonly messages: { readonly id: string; readonly text: string }[];
  readonly expected: {
    readonly before_answers: {
      readonly revision: number;
      readonly field_states: Record<string, string>;
      readonly field_values: Record<string, unknown>;
      readonly field_reasons: Record<string, string[]>;
      readonly questions: string[];
      readonly question_options: Record<string, unknown[]>;
      readonly optional_terms_fields: string[];
      readonly not_included: NotIncludedExpect[];
      readonly accepted_clause_ids: string[];
      readonly render_blocked_reasons: string[];
    };
    readonly answers: { readonly question_id: string; readonly answer: unknown }[];
    readonly after_answers: {
      readonly revision: number;
      readonly field_states: Record<string, string>;
      readonly field_values: Record<string, unknown>;
      readonly field_methods: Record<string, string>;
      readonly questions: string[];
      readonly clause_ids: string[];
      readonly not_included: NotIncludedExpect[];
      readonly markdown_contains: string[];
      readonly markdown_excludes: string[];
    };
  };
}

export function loadJson<T>(relativeToFixtures: string): T {
  const url = new URL(`../../fixtures/${relativeToFixtures}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as T;
}

/** Deterministic clock: 2026-10-24T12:00:01.000Z, ...:02, ... */
export function fixedClock(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `2026-10-24T12:${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}.000Z`;
  };
}

export function intakeOf(...texts: string[]): Intake {
  const r = normaliseIntake(texts.map((text) => ({ text })));
  if (!r.ok) throw new Error(`test intake invalid: ${r.error.code}`);
  return { messages: r.messages, total_utf16: r.total_utf16 };
}

/** Pointer for the n-th (0-based) occurrence of `quote` in message `id` of `text`. */
export function ptr(text: string, quote: string, id = 'm1', occurrence = 0): string {
  let s = -1;
  for (let i = 0; i <= occurrence; i++) {
    s = text.indexOf(quote, s + 1);
    if (s < 0) throw new Error(`quote not in text: ${quote}`);
  }
  return `msg:${id}:${s}-${s + quote.length}`;
}

/** Ground proposals against an intake built from texts (code candidates found as in the pipeline). */
export function ground(texts: string[], proposals: FieldProposal[], method: ExtractorMethod = 'llm'): GroundingResult {
  const intake = intakeOf(...texts);
  const all = findAllCandidates(intake);
  return groundFields({ intake, candidates: all.candidates, proposals, method });
}

export async function extractScenario(f: MockFixture & { readonly messages: { id: string; text: string }[] }): Promise<MatterState> {
  const r = await runExtraction(f.messages, createMockExtractor(f, f.scenario_id));
  if (!r.ok) throw new Error(`fixture intake invalid: ${r.error.code}`);
  return r.state;
}

export function answerAll(
  state: MatterState,
  answers: readonly { readonly question_id: string; readonly answer: unknown }[],
  clock: () => string = fixedClock(),
): MatterState {
  let s = state;
  for (const a of answers) {
    const r = applyAnswer(s, a.question_id, a.answer, { clock });
    if (!r.ok) throw new Error(`answer ${a.question_id} rejected: ${r.error.code} ${r.error.detail}`);
    s = r.state;
  }
  return s;
}

/** Base field records for validate/select tests: every field missing unless overridden. */
export function records(overrides: Partial<Record<FieldKey, GroundedField>> = {}): Record<FieldKey, GroundedField> {
  const out = {} as Record<FieldKey, GroundedField>;
  for (const k of Object.keys(FIELD_SPECS) as FieldKey[]) {
    out[k] = overrides[k] ?? { field: k, state: 'missing', candidates: [], reasons: ['no_proposal'] };
  }
  return out;
}

export function valid(field: FieldKey, value: FieldValue, extra: Partial<GroundedField> = {}): GroundedField {
  return {
    field,
    state: 'valid',
    value,
    method: 'mock',
    quote: 'q',
    pointer: 'msg:m1:0-1',
    candidates: [],
    reasons: [],
    ...extra,
  };
}

export function noneConfirmed(field: FieldKey): GroundedField {
  return {
    field,
    state: 'none_confirmed',
    method: 'none_confirmed',
    candidates: [],
    reasons: [],
    answer: { question_id: 'q.optional_terms.v1', answer: { kind: 'none' }, answered_at: '2026-10-24T12:00:00.000Z' },
  };
}

/** A complete, renderable set of effective-looking base records (demo-01 values after answers). */
export function completeRecords(overrides: Partial<Record<FieldKey, GroundedField>> = {}): Record<FieldKey, GroundedField> {
  return records({
    landlord: valid('landlord', 'Sam Patel'),
    tenants: valid('tenants', ['Priya Shah', 'Joe Bloggs']),
    address: valid('address', '14 Elm Road, Flat 2, Oxtown'),
    start_date: valid('start_date', '2027-03-01'),
    term_months: valid('term_months', 12),
    end_date: { field: 'end_date', state: 'missing', candidates: [], reasons: ['no_proposal'] },
    monthly_rent: valid('monthly_rent', 120000),
    rent_due_day: valid('rent_due_day', 1),
    deposit: valid('deposit', 120000),
    pets: valid('pets', 'with_consent'),
    smoking: valid('smoking', 'prohibited'),
    furnished: valid('furnished', 'furnished'),
    utilities: valid('utilities', ['electricity', 'gas']),
    guarantor: noneConfirmed('guarantor'),
    break_month: noneConfirmed('break_month'),
    ...overrides,
  });
}
