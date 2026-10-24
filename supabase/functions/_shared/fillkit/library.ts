// Library lock: compute, verify and load (PLAN sections 4.3 and K17).
// - computeLock(content): sha256 of canonical JSON of every clause record, every frame record and the
//   jurisdiction config, plus an overall hash. Pure and deterministic.
// - validateContent(content): static checks on the authored content (ids, orders, placeholders, DSL).
// - verifyLibrary(content, lock): fail-closed verification. The UNLOCKED sentinel always fails with
//   reasons ['library_unlocked'] (plus any content-validation reasons); per-record mismatches name the record.
// Nothing here ever relocks: a lock is written only by `npm run lock` (scripts/lock.ts).
import { canonicalJson } from './canonicalJson.ts';
import { isSha256Hex, sha256Hex } from './hash.ts';
import { CLAUSES } from '../content/clauses.ts';
import { FRAME } from '../content/frame.ts';
import { JURISDICTION } from '../content/jurisdiction.ts';
import { LIBRARY_LOCK } from '../content/library.lock.ts';
import {
  CLAUSE_CATEGORIES,
  CLAUSE_LICENCE,
  DERIVED_PLACEHOLDERS,
  FIELD_KEYS,
  FIELD_KIND_OF,
  FRAME_KINDS,
  JURISDICTION_PLACEHOLDER_KEYS,
  LOCK_FORMAT_VERSION,
  METHOD_TOKENS,
  PREDICATE_OPERATORS,
  REQUIRED_FRAME_IDS,
} from '../content/types.ts';
import type {
  ClauseRecord,
  FrameRecord,
  Jurisdiction,
  LibraryContent,
  LibraryLock,
  LockedLibraryLock,
  PlaceholderSpec,
} from '../content/types.ts';

export type LibraryVerification =
  | { readonly ok: true; readonly lock: LockedLibraryLock }
  | { readonly ok: false; readonly reasons: readonly string[] };

const ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const PLACEHOLDER_TOKEN = /\{\{([a-z_][a-z0-9_]*)\}\}/g;

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isFieldKey(value: unknown): boolean {
  return typeof value === 'string' && (FIELD_KEYS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------------------------------------------

/** sha256 of the canonical JSON of one record (clause, frame record or jurisdiction). */
export function hashRecord(record: unknown): string {
  return sha256Hex(canonicalJson(record));
}

/** Overall library hash: sha256 of canonical JSON of {version, clauses, frame, jurisdiction}. */
export function overallHash(
  version: number,
  clauses: Readonly<Record<string, string>>,
  frame: Readonly<Record<string, string>>,
  jurisdiction: string,
): string {
  return sha256Hex(canonicalJson({ version, clauses, frame, jurisdiction }));
}

/**
 * Compute the lock for the given content. Deterministic: depends only on the canonical JSON of the records
 * (object key order in the source does not matter; array order does). Duplicate ids are rejected because a
 * map keyed by id could not represent them (run validateContent first for a full report).
 */
export function computeLock(content: LibraryContent): LockedLibraryLock {
  const clauses: Record<string, string> = {};
  for (const clause of content.clauses) {
    if (hasOwn(clauses, clause.id)) {
      throw new Error(`computeLock: duplicate clause id ${clause.id}`);
    }
    clauses[clause.id] = hashRecord(clause);
  }
  const frame: Record<string, string> = {};
  for (const record of content.frame) {
    if (hasOwn(frame, record.id)) {
      throw new Error(`computeLock: duplicate frame id ${record.id}`);
    }
    frame[record.id] = hashRecord(record);
  }
  const jurisdiction = hashRecord(content.jurisdiction);
  const overall = overallHash(LOCK_FORMAT_VERSION, clauses, frame, jurisdiction);
  return { status: 'LOCKED', version: LOCK_FORMAT_VERSION, clauses, frame, jurisdiction, overall };
}

// ---------------------------------------------------------------------------------------------------------------
// Static content validation
// ---------------------------------------------------------------------------------------------------------------

/** Validate one predicate (DSL operators of PLAN section 4.3 only). Pushes reasons prefixed with `where`. */
export function validatePredicate(predicate: unknown, where: string, reasons: string[]): void {
  if (predicate === true) {
    return;
  }
  if (typeof predicate !== 'object' || predicate === null || Array.isArray(predicate)) {
    reasons.push(`${where}: predicate must be true or an operator object`);
    return;
  }
  const keys = Object.keys(predicate);
  if (keys.length !== 1) {
    reasons.push(`${where}: predicate object must have exactly one operator`);
    return;
  }
  const op = keys[0];
  if (!(PREDICATE_OPERATORS as readonly string[]).includes(op)) {
    reasons.push(`${where}: unknown predicate operator ${op}`);
    return;
  }
  const arg: unknown = (predicate as Record<string, unknown>)[op];
  switch (op) {
    case 'all':
    case 'any':
      if (!Array.isArray(arg) || arg.length === 0) {
        reasons.push(`${where}: ${op} needs a non-empty list`);
        return;
      }
      arg.forEach((child: unknown, i: number) => validatePredicate(child, `${where}.${op}[${i}]`, reasons));
      return;
    case 'not':
      validatePredicate(arg, `${where}.not`, reasons);
      return;
    case 'eq': {
      if (!Array.isArray(arg) || arg.length !== 2 || !isFieldKey(arg[0])) {
        reasons.push(`${where}: eq needs [field, value]`);
        return;
      }
      const v: unknown = arg[1];
      if (typeof v !== 'string' && typeof v !== 'boolean' && !(typeof v === 'number' && Number.isFinite(v))) {
        reasons.push(`${where}: eq value must be a string, finite number or boolean`);
      }
      return;
    }
    case 'countGte':
      if (
        !Array.isArray(arg) ||
        arg.length !== 2 ||
        !isFieldKey(arg[0]) ||
        typeof arg[1] !== 'number' ||
        !Number.isInteger(arg[1]) ||
        arg[1] < 0
      ) {
        reasons.push(`${where}: countGte needs [field, non-negative integer]`);
      }
      return;
    case 'nonEmpty':
    case 'complementNonEmpty':
    case 'present':
      if (!isFieldKey(arg)) {
        reasons.push(`${where}: ${op} needs a field name`);
      }
      return;
    default:
      reasons.push(`${where}: unknown predicate operator ${op}`);
  }
}

/** Placeholder names used in a text (in order of appearance). Stray `{{` / `}}` are reported separately. */
export function placeholderNamesIn(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER_TOKEN)) {
    names.push(match[1]);
  }
  return names;
}

function hasStrayBraces(text: string): boolean {
  const withoutTokens = text.replace(PLACEHOLDER_TOKEN, '');
  return withoutTokens.includes('{{') || withoutTokens.includes('}}');
}

function validatePlaceholderSpec(spec: PlaceholderSpec, where: string, reasons: string[]): void {
  switch (spec.source) {
    case 'field': {
      if (!isFieldKey(spec.name)) {
        reasons.push(`${where}: placeholder ${spec.name} is not a schema field`);
        return;
      }
      const kind = FIELD_KIND_OF[spec.name as keyof typeof FIELD_KIND_OF];
      if (spec.from !== spec.name || spec.kind !== kind) {
        reasons.push(`${where}: placeholder ${spec.name} must have from=${spec.name} and kind=${kind}`);
      }
      return;
    }
    case 'derived': {
      if (!hasOwn(DERIVED_PLACEHOLDERS, spec.name)) {
        reasons.push(`${where}: placeholder ${spec.name} is not a known derived value`);
        return;
      }
      const def = DERIVED_PLACEHOLDERS[spec.name as keyof typeof DERIVED_PLACEHOLDERS];
      if (spec.from !== def.from || spec.kind !== def.kind) {
        reasons.push(`${where}: placeholder ${spec.name} must have from=${def.from} and kind=${def.kind}`);
      }
      return;
    }
    case 'jurisdiction':
      if (!(JURISDICTION_PLACEHOLDER_KEYS as readonly string[]).includes(spec.name)) {
        reasons.push(`${where}: placeholder ${spec.name} is not a jurisdiction value`);
        return;
      }
      if (spec.from !== spec.name || spec.kind !== 'int') {
        reasons.push(`${where}: placeholder ${spec.name} must have from=${spec.name} and kind=int`);
      }
      return;
    default:
      reasons.push(`${where}: placeholder ${String((spec as { name?: unknown }).name)} has an unknown source`);
  }
}

function validateClause(clause: ClauseRecord, reasons: string[]): void {
  const where = `clause:${clause.id}`;
  if (typeof clause.id !== 'string' || !ID_PATTERN.test(clause.id)) {
    reasons.push(`${where}: id must be kebab-case`);
  }
  if (!isPositiveInteger(clause.version)) {
    reasons.push(`${where}: version must be a positive integer`);
  }
  if (typeof clause.title !== 'string' || clause.title.trim() === '') {
    reasons.push(`${where}: title is required`);
  }
  if (!isPositiveInteger(clause.order)) {
    reasons.push(`${where}: order must be a positive integer`);
  }
  if (!(CLAUSE_CATEGORIES as readonly string[]).includes(clause.category)) {
    reasons.push(`${where}: unknown category ${String(clause.category)}`);
  }
  if (clause.licence !== CLAUSE_LICENCE) {
    reasons.push(`${where}: licence must be "${CLAUSE_LICENCE}"`);
  }
  if (typeof clause.author !== 'string' || clause.author.trim() === '') {
    reasons.push(`${where}: author is required`);
  }
  if (typeof clause.text !== 'string' || clause.text.trim() === '') {
    reasons.push(`${where}: text is required`);
    return;
  }
  validatePredicate(clause.applies, `${where}.applies`, reasons);
  if (clause.category === 'mandatory' && clause.applies !== true) {
    reasons.push(`${where}: a mandatory clause must have applies = true`);
  }
  if (hasStrayBraces(clause.text)) {
    reasons.push(`${where}: text has a stray {{ or }} that is not a placeholder token`);
  }
  const declared = new Set<string>();
  for (const spec of clause.placeholders) {
    if (declared.has(spec.name)) {
      reasons.push(`${where}: placeholder ${spec.name} declared twice`);
    }
    declared.add(spec.name);
    validatePlaceholderSpec(spec, where, reasons);
  }
  const used = new Set(placeholderNamesIn(clause.text));
  for (const name of used) {
    if (!declared.has(name)) {
      reasons.push(`${where}: placeholder ${name} used in text but not declared`);
    }
  }
  for (const name of declared) {
    if (!used.has(name)) {
      reasons.push(`${where}: placeholder ${name} declared but not used in text`);
    }
  }
}

function validateFrameRecord(record: FrameRecord, reasons: string[]): void {
  const where = `frame:${record.id}`;
  if (typeof record.id !== 'string' || !ID_PATTERN.test(record.id)) {
    reasons.push(`${where}: id must be kebab-case`);
  }
  if (!isPositiveInteger(record.version)) {
    reasons.push(`${where}: version must be a positive integer`);
  }
  if (!(FRAME_KINDS as readonly string[]).includes(record.kind)) {
    reasons.push(`${where}: unknown kind ${String(record.kind)}`);
  }
  if (typeof record.text !== 'string' || record.text === '') {
    reasons.push(`${where}: text is required`);
    return;
  }
  if (hasStrayBraces(record.text)) {
    reasons.push(`${where}: text has a stray {{ or }} that is not a placeholder token`);
  }
  const declared = new Set(record.placeholders.map((p) => p.name));
  const used = new Set(placeholderNamesIn(record.text));
  for (const name of used) {
    if (!declared.has(name)) {
      reasons.push(`${where}: placeholder ${name} used in text but not declared`);
    }
  }
  for (const name of declared) {
    if (!used.has(name)) {
      reasons.push(`${where}: placeholder ${name} declared but not used in text`);
    }
  }
  if (record.kind === 'heading') {
    if (!isPositiveInteger(record.from_order)) {
      reasons.push(`${where}: heading needs a positive integer from_order`);
    }
  } else if (record.from_order !== undefined) {
    reasons.push(`${where}: only heading records may have from_order`);
  }
  if (record.kind === 'token_list') {
    if (!Array.isArray(record.tokens) || record.tokens.length === 0) {
      reasons.push(`${where}: token_list needs a non-empty tokens list`);
    }
  } else if (record.tokens !== undefined) {
    reasons.push(`${where}: only token_list records may have tokens`);
  }
}

function validateJurisdiction(j: Jurisdiction, reasons: string[]): void {
  const ints: Array<[string, unknown]> = [
    ['version', j.version],
    ['deposit_cap_weeks', j.deposit_cap_weeks],
    ['term_months_min', j.term_months_min],
    ['term_months_max', j.term_months_max],
    ['due_day_min', j.due_day_min],
    ['due_day_max', j.due_day_max],
    ['notice_hours_landlord_entry', j.notice_hours_landlord_entry],
    ['notice_days_tenant_end', j.notice_days_tenant_end],
    ['notice_days_landlord_end', j.notice_days_landlord_end],
  ];
  for (const [key, value] of ints) {
    if (!isPositiveInteger(value)) {
      reasons.push(`jurisdiction: ${key} must be a positive integer`);
    }
  }
  if (j.term_months_min > j.term_months_max) {
    reasons.push('jurisdiction: term_months_min must not exceed term_months_max');
  }
  if (j.due_day_min > j.due_day_max || j.due_day_max > 28) {
    reasons.push('jurisdiction: due day range must be within 1..28');
  }
  if (j.currency.code !== 'GBP' || j.currency.symbol === '') {
    reasons.push('jurisdiction: currency must be GBP with a symbol');
  }
  if (!j.label.includes('not any real law')) {
    reasons.push('jurisdiction: label must say "not any real law"');
  }
}

/** All static problems with the content; empty when valid. */
export function validateContent(content: LibraryContent): string[] {
  const reasons: string[] = [];

  const clauseIds = new Set<string>();
  const clauseOrders = new Set<number>();
  for (const clause of content.clauses) {
    if (clauseIds.has(clause.id)) {
      reasons.push(`clause:${clause.id}: duplicate id`);
    }
    clauseIds.add(clause.id);
    if (clauseOrders.has(clause.order)) {
      reasons.push(`clause:${clause.id}: duplicate order ${clause.order}`);
    }
    clauseOrders.add(clause.order);
    validateClause(clause, reasons);
  }

  const frameIds = new Set<string>();
  const headingOrders = new Set<number>();
  for (const record of content.frame) {
    if (frameIds.has(record.id)) {
      reasons.push(`frame:${record.id}: duplicate id`);
    }
    frameIds.add(record.id);
    if (record.kind === 'heading' && record.from_order !== undefined) {
      if (headingOrders.has(record.from_order)) {
        reasons.push(`frame:${record.id}: duplicate heading from_order ${record.from_order}`);
      }
      headingOrders.add(record.from_order);
    }
    validateFrameRecord(record, reasons);
  }
  for (const id of REQUIRED_FRAME_IDS) {
    if (!frameIds.has(id)) {
      reasons.push(`frame:${id}: required frame record missing`);
    }
  }
  const methodTokens = content.frame.find((r) => r.id === 'method-tokens');
  if (methodTokens !== undefined && canonicalJson(methodTokens.tokens ?? []) !== canonicalJson(METHOD_TOKENS)) {
    reasons.push('frame:method-tokens: tokens must equal the closed method token list');
  }

  validateJurisdiction(content.jurisdiction, reasons);
  return reasons;
}

// ---------------------------------------------------------------------------------------------------------------
// Verification and loading
// ---------------------------------------------------------------------------------------------------------------

function compareMaps(
  kind: 'clause' | 'frame',
  expected: Readonly<Record<string, string>>,
  actual: Readonly<Record<string, string>>,
  reasons: string[],
): void {
  for (const id of Object.keys(expected).sort()) {
    if (!hasOwn(actual, id)) {
      reasons.push(`lock_missing_${kind}:${id}`);
    } else if (actual[id] !== expected[id]) {
      reasons.push(`${kind}_hash_mismatch:${id}`);
    }
  }
  for (const id of Object.keys(actual).sort()) {
    if (!hasOwn(expected, id)) {
      reasons.push(`lock_extra_${kind}:${id}`);
    }
  }
}

function lockShapeProblems(lock: LockedLibraryLock): string[] {
  const problems: string[] = [];
  const maps: Array<[string, unknown]> = [
    ['clauses', lock.clauses],
    ['frame', lock.frame],
  ];
  for (const [name, map] of maps) {
    if (typeof map !== 'object' || map === null || Array.isArray(map)) {
      problems.push(`lock_malformed:${name}`);
      continue;
    }
    for (const [id, digest] of Object.entries(map as Record<string, unknown>)) {
      if (!isSha256Hex(digest)) {
        problems.push(`lock_malformed:${name}.${id}`);
      }
    }
  }
  if (!isSha256Hex(lock.jurisdiction)) {
    problems.push('lock_malformed:jurisdiction');
  }
  if (!isSha256Hex(lock.overall)) {
    problems.push('lock_malformed:overall');
  }
  return problems;
}

/**
 * Verify content against a lock. Fail-closed: anything other than a LOCKED lock whose every hash matches
 * freshly computed hashes of valid content is `ok: false` with reasons.
 * - UNLOCKED sentinel -> reasons ['library_unlocked', ...content validation reasons]
 * - per-record mismatch -> `clause_hash_mismatch:<id>` / `frame_hash_mismatch:<id>`,
 *   `lock_missing_<kind>:<id>`, `lock_extra_<kind>:<id>`, `jurisdiction_hash_mismatch`, `overall_hash_mismatch`
 * - invalid content -> `content_invalid:<detail>`
 */
export function verifyLibrary(content: LibraryContent, lock: LibraryLock): LibraryVerification {
  const contentReasons = validateContent(content).map((r) => `content_invalid:${r}`);

  if (lock.status !== 'LOCKED') {
    return { ok: false, reasons: ['library_unlocked', ...contentReasons] };
  }
  if (lock.version !== LOCK_FORMAT_VERSION) {
    return { ok: false, reasons: [`lock_version_unsupported:${String(lock.version)}`, ...contentReasons] };
  }
  const shape = lockShapeProblems(lock);
  if (shape.length > 0) {
    return { ok: false, reasons: [...shape, ...contentReasons] };
  }
  if (contentReasons.length > 0) {
    return { ok: false, reasons: contentReasons };
  }

  let computed: LockedLibraryLock;
  try {
    computed = computeLock(content);
  } catch (error) {
    return { ok: false, reasons: [`content_unhashable:${error instanceof Error ? error.message : String(error)}`] };
  }

  const reasons: string[] = [];
  compareMaps('clause', computed.clauses, lock.clauses, reasons);
  compareMaps('frame', computed.frame, lock.frame, reasons);
  if (computed.jurisdiction !== lock.jurisdiction) {
    reasons.push('jurisdiction_hash_mismatch');
  }
  // The overall hash is recomputed from the lock's own maps too, so a lock edited by hand is caught even when
  // its per-record entries were updated consistently with the content.
  const lockSelfOverall = overallHash(lock.version, lock.clauses, lock.frame, lock.jurisdiction);
  if (computed.overall !== lock.overall || lockSelfOverall !== lock.overall) {
    reasons.push('overall_hash_mismatch');
  }
  if (reasons.length > 0) {
    return { ok: false, reasons };
  }
  return { ok: true, lock: computed };
}

/** The committed content as one object. */
export const LIBRARY_CONTENT: LibraryContent = {
  clauses: CLAUSES,
  frame: FRAME,
  jurisdiction: JURISDICTION,
};

/** Load the committed content and verify it against the committed lock (fail-closed). */
export function loadLibrary(): { readonly content: LibraryContent; readonly verification: LibraryVerification } {
  return { content: LIBRARY_CONTENT, verification: verifyLibrary(LIBRARY_CONTENT, LIBRARY_LOCK) };
}
