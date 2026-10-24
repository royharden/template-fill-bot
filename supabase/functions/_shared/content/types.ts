// Shared types (and the small closed vocabularies they draw on) for the locked content:
// clause records, frame records, the jurisdiction config and the library lock.
// Pure data: no runtime APIs. Hashes are computed over canonical JSON of these records (fillkit/library.ts).

/** The 15 schema fields (PLAN section 4.1). */
export const FIELD_KEYS = [
  'landlord',
  'tenants',
  'address',
  'start_date',
  'term_months',
  'end_date',
  'monthly_rent',
  'rent_due_day',
  'deposit',
  'pets',
  'smoking',
  'furnished',
  'utilities',
  'guarantor',
  'break_month',
] as const;
export type FieldKey = (typeof FIELD_KEYS)[number];

export const FIELD_KINDS = [
  'money',
  'date',
  'int',
  'enum',
  'enumSet',
  'name',
  'nameList',
  'address',
  'computed',
] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

/** Kind of each schema field (PLAN section 4.1). */
export const FIELD_KIND_OF: Readonly<Record<FieldKey, FieldKind>> = {
  landlord: 'name',
  tenants: 'nameList',
  address: 'address',
  start_date: 'date',
  term_months: 'int',
  end_date: 'computed',
  monthly_rent: 'money',
  rent_due_day: 'int',
  deposit: 'money',
  pets: 'enum',
  smoking: 'enum',
  furnished: 'enum',
  utilities: 'enumSet',
  guarantor: 'name',
  break_month: 'int',
};

/** Closed category list for the `utilities` field: the set of categories the TENANT pays (PLAN K9). */
export const UTILITY_CATEGORIES = ['water', 'electricity', 'gas', 'internet'] as const;
export type UtilityCategory = (typeof UTILITY_CATEGORIES)[number];

/**
 * Named derived values a clause may use as a placeholder. Each is rendered by code from one schema field;
 * the renderer (M3) and the gate (M4) each implement the derivation independently.
 */
export const DERIVED_PLACEHOLDERS = {
  /** tenants joined with the locked join tokens (", " and final " and "). */
  tenants_list: { kind: 'nameList', from: 'tenants' },
  /** rent_due_day as an English ordinal: 1st, 2nd, 3rd, 4th ... 28th. */
  rent_due_day_ordinal: { kind: 'int', from: 'rent_due_day' },
  /** tenant-paid utility categories in closed-list order, joined with the locked join tokens. */
  utilities_tenant_list: { kind: 'enumSet', from: 'utilities' },
  /** complement of utilities (included in rent) in closed-list order, joined with the locked join tokens. */
  utilities_included_list: { kind: 'enumSet', from: 'utilities' },
} as const satisfies Readonly<Record<string, { readonly kind: FieldKind; readonly from: FieldKey }>>;
export type DerivedPlaceholderName = keyof typeof DERIVED_PLACEHOLDERS;

/** Jurisdiction values that clause text may show as value segments (all integers). */
export const JURISDICTION_PLACEHOLDER_KEYS = [
  'notice_hours_landlord_entry',
  'notice_days_tenant_end',
  'notice_days_landlord_end',
  'deposit_cap_weeks',
] as const;
export type JurisdictionPlaceholderKey = (typeof JURISDICTION_PLACEHOLDER_KEYS)[number];

export type PlaceholderSource = 'field' | 'derived' | 'jurisdiction';

/**
 * One `{{name}}` placeholder used by a clause.
 * - source 'field': name is a schema field, from === name, kind === FIELD_KIND_OF[name].
 * - source 'derived': name is a DERIVED_PLACEHOLDERS key; kind and from match that entry.
 * - source 'jurisdiction': name is a JURISDICTION_PLACEHOLDER_KEYS entry, from === name, kind 'int'.
 */
export interface PlaceholderSpec {
  readonly name: string;
  readonly kind: FieldKind;
  readonly source: PlaceholderSource;
  readonly from: string;
}

/**
 * Declarative clause applicability predicate (data, not code). Exactly these operators (PLAN section 4.3):
 * - `true`                          always applies
 * - `{all: [...]}` / `{any: [...]}` conjunction / disjunction of a non-empty list
 * - `{not: p}`                      negation
 * - `{eq: [field, value]}`          field is valid and equals value
 * - `{nonEmpty: field}`             set/list field is valid and has at least one member
 * - `{complementNonEmpty: field}`   enumSet field is valid and its complement in the closed list is non-empty
 * - `{countGte: [field, n]}`        list field is valid and has at least n members
 * - `{present: field}`              field is in state `valid` (an optional field that is `none_confirmed` is not present)
 */
export type PredicateScalar = string | number | boolean;
export type Predicate =
  | true
  | { readonly all: readonly Predicate[] }
  | { readonly any: readonly Predicate[] }
  | { readonly not: Predicate }
  | { readonly eq: readonly [FieldKey, PredicateScalar] }
  | { readonly nonEmpty: FieldKey }
  | { readonly complementNonEmpty: FieldKey }
  | { readonly countGte: readonly [FieldKey, number] }
  | { readonly present: FieldKey };

export const PREDICATE_OPERATORS = [
  'all',
  'any',
  'not',
  'eq',
  'nonEmpty',
  'complementNonEmpty',
  'countGte',
  'present',
] as const;
export type PredicateOperator = (typeof PREDICATE_OPERATORS)[number];

export const CLAUSE_CATEGORIES = ['mandatory', 'branch', 'requestable'] as const;
export type ClauseCategory = (typeof CLAUSE_CATEGORIES)[number];

export const CLAUSE_LICENCE = 'MIT (self-authored)';

/** One locked clause record (PLAN section 4.3). Every field is covered by the record's hash. */
export interface ClauseRecord {
  readonly id: string;
  readonly version: number;
  readonly title: string;
  readonly order: number;
  readonly category: ClauseCategory;
  readonly applies: Predicate;
  readonly placeholders: readonly PlaceholderSpec[];
  readonly text: string;
  readonly licence: typeof CLAUSE_LICENCE;
  readonly author: string;
}

export const FRAME_KINDS = [
  'title',
  'notice',
  'heading',
  'appendix_label',
  'join_token',
  'sentence',
  'token_list',
] as const;
export type FrameKind = (typeof FRAME_KINDS)[number];

/** A placeholder inside frame text (only the "requests were not included" sentence uses one). */
export interface FramePlaceholderSpec {
  readonly name: string;
  readonly kind: 'int';
  readonly meaning: string;
}

/**
 * One locked frame record: document text that is not a clause.
 * - heading records carry `from_order`: the heading is emitted before the first selected clause whose
 *   `order` is >= from_order (and below the next heading's from_order); a heading with no selected clause in
 *   its range is not emitted.
 * - token_list records carry `tokens` (closed token list); their `text` is a human description.
 */
export interface FrameRecord {
  readonly id: string;
  readonly version: number;
  readonly kind: FrameKind;
  readonly text: string;
  readonly placeholders: readonly FramePlaceholderSpec[];
  readonly from_order?: number;
  readonly tokens?: readonly string[];
}

/** Frame ids that the renderer and gate rely on; content validation requires all of them. */
export const REQUIRED_FRAME_IDS = [
  'title',
  'draft-notice',
  'jurisdiction-notice',
  'join-list-separator',
  'join-list-final',
  'requests-not-included-one',
  'requests-not-included-many',
  'method-tokens',
  'appendix-heading',
  'appendix-label-field-values',
  'appendix-label-field',
  'appendix-label-value',
  'appendix-label-method',
  'appendix-label-pointer',
  'appendix-label-clauses',
  'appendix-label-clause-version',
  'appendix-label-library-hash',
  'appendix-label-jurisdiction-hash',
  'appendix-label-content-hash',
] as const;

/** Closed method tokens shown in the appendix (PLAN section 4.6). */
export const METHOD_TOKENS = ['regex', 'llm', 'jev', 'mock', 'user_answer', 'none_confirmed'] as const;
export type MethodToken = (typeof METHOD_TOKENS)[number];

/** Illustrative jurisdiction config (PLAN section 4.2). */
export interface Jurisdiction {
  readonly id: string;
  readonly version: number;
  readonly label: string;
  readonly currency: { readonly code: 'GBP'; readonly symbol: string };
  readonly deposit_cap_weeks: number;
  readonly term_months_min: number;
  readonly term_months_max: number;
  readonly due_day_min: number;
  readonly due_day_max: number;
  readonly notice_hours_landlord_entry: number;
  readonly notice_days_tenant_end: number;
  readonly notice_days_landlord_end: number;
}

/** Everything the lock covers. */
export interface LibraryContent {
  readonly clauses: readonly ClauseRecord[];
  readonly frame: readonly FrameRecord[];
  readonly jurisdiction: Jurisdiction;
}

/** Lock file format version understood by fillkit/library.ts. */
export const LOCK_FORMAT_VERSION = 1;

/** Committed sentinel until DV-LOCK: any render or gate run fails closed with reason `library_unlocked`. */
export interface UnlockedLibraryLock {
  readonly status: 'UNLOCKED';
  readonly note: string;
}

/** Generated by `npm run lock`: sha256 (lowercase hex) of canonical JSON of each record. */
export interface LockedLibraryLock {
  readonly status: 'LOCKED';
  readonly version: number;
  readonly clauses: Readonly<Record<string, string>>;
  readonly frame: Readonly<Record<string, string>>;
  readonly jurisdiction: string;
  readonly overall: string;
}

export type LibraryLock = UnlockedLibraryLock | LockedLibraryLock;
