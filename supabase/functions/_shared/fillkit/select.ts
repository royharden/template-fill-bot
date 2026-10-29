// Clause selection (PLAN section 4.6) and the renderer-side predicate evaluator for the clause DSL (section 4.3).
// Pure. The independent gate (fillkit/gate/, M4) has its OWN evaluator and must never import this file.
//
// Selected = every mandatory clause + every branch clause whose `applies` holds + every requestable clause that
// an accepted, grounded, user-confirmed request names AND whose `applies` holds; sorted by `order` (then id).
import { FIELD_KEYS, UTILITY_CATEGORIES } from '../content/types.ts';
import type { ClauseRecord, FieldKey, LibraryContent, Predicate } from '../content/types.ts';
import type { FieldValue } from './fields.ts';
import type { FieldState } from './schema.ts';

/** The minimum the evaluator reads from each field. */
export interface FieldStateLike {
  readonly state: FieldState;
  readonly value?: FieldValue;
}
export type FieldStateView = Readonly<Record<FieldKey, FieldStateLike>>;

function isFieldKey(value: unknown): value is FieldKey {
  return typeof value === 'string' && (FIELD_KEYS as readonly string[]).includes(value);
}

function validValue(fields: FieldStateView, key: unknown): FieldValue | undefined {
  if (!isFieldKey(key)) return undefined;
  const f = fields[key];
  return f !== undefined && f.state === 'valid' ? f.value : undefined;
}

/**
 * Evaluate a clause predicate against field states. Semantics (content/types.ts): `eq` needs the field valid
 * and strictly equal; `nonEmpty` / `countGte` need a valid list; `complementNonEmpty` needs a valid utilities
 * set with at least one closed-list category missing from it; `present` means state `valid` (an optional
 * field that is `none_confirmed` is not present). Anything malformed evaluates to false (fail closed).
 */
export function evaluatePredicate(predicate: Predicate, fields: FieldStateView): boolean {
  if (predicate === true) return true;
  if (typeof predicate !== 'object' || predicate === null) return false;
  const keys = Object.keys(predicate);
  if (keys.length !== 1) return false;
  const p = predicate as Record<string, unknown>;
  if ('all' in predicate) {
    const list = p.all;
    return Array.isArray(list) && list.length > 0 && list.every((c) => evaluatePredicate(c as Predicate, fields));
  }
  if ('any' in predicate) {
    const list = p.any;
    return Array.isArray(list) && list.length > 0 && list.some((c) => evaluatePredicate(c as Predicate, fields));
  }
  if ('not' in predicate) {
    return !evaluatePredicate(p.not as Predicate, fields);
  }
  if ('eq' in predicate) {
    const arg = p.eq;
    if (!Array.isArray(arg) || arg.length !== 2) return false;
    const v = validValue(fields, arg[0]);
    return v !== undefined && !Array.isArray(v) && v === arg[1];
  }
  if ('nonEmpty' in predicate) {
    const v = validValue(fields, p.nonEmpty);
    return Array.isArray(v) && v.length > 0;
  }
  if ('complementNonEmpty' in predicate) {
    const v = validValue(fields, p.complementNonEmpty);
    return Array.isArray(v) && UTILITY_CATEGORIES.some((c) => !v.includes(c));
  }
  if ('countGte' in predicate) {
    const arg = p.countGte;
    if (!Array.isArray(arg) || arg.length !== 2 || typeof arg[1] !== 'number') return false;
    const v = validValue(fields, arg[0]);
    return Array.isArray(v) && v.length >= arg[1];
  }
  if ('present' in predicate) {
    return validValue(fields, p.present) !== undefined;
  }
  return false;
}

function byOrder(a: ClauseRecord, b: ClauseRecord): number {
  return a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Selected clauses in document order. `acceptedClauseIds` come from requests.ts evaluateRequests().accepted. */
export function selectClauses(
  content: LibraryContent,
  fields: FieldStateView,
  acceptedClauseIds: readonly string[],
): ClauseRecord[] {
  const accepted = new Set(acceptedClauseIds);
  const out: ClauseRecord[] = [];
  for (const clause of content.clauses) {
    switch (clause.category) {
      case 'mandatory':
        out.push(clause);
        break;
      case 'branch':
        if (evaluatePredicate(clause.applies, fields)) out.push(clause);
        break;
      case 'requestable':
        if (accepted.has(clause.id) && evaluatePredicate(clause.applies, fields)) out.push(clause);
        break;
      default:
        break;
    }
  }
  return out.sort(byOrder);
}
