// Role candidates (PLAN section 4.4 role grammar; the regex baseline uses the same grammar):
//   landlord:  `landlord: X` | `landlord is X` | `X, the landlord` | `it's X, the landlord`
//   tenants:   `tenants: X` | `rent(s) [<address>] to X and Y` | `renting <address> to X and Y`
//   guarantor: `guarantor: X` | `guarantor is X` | unresolved `guarantor for <tenant> only`
//   address:   `property: X` | `address: X` | `property at X` | `property/address is (at) X` | `renting <address> to`
// Payload rule: a payload that FOLLOWS its cue is trimmed and ends before the first `.` `!` `?` `;` or
// newline after it; the terminator is never part of the value, quote or pointer span.
// Keyword matching is case-insensitive via explicit character classes (no `i` flag) so `\p{Lu}` keeps its
// meaning; "is"/"rent ... to" forms require the payload to start with an upper-case letter (or a digit for
// addresses) to avoid narrative false positives ("the landlord is happy ...").
import type { FieldKey } from '../../content/types.ts';
import type { IntakeLike } from '../normalize.ts';
import type { Candidate } from '../schema.ts';
import { candidateId, ci, payloadEnd, pointerFor, trimSpan } from './text.ts';
import type { Span } from './text.ts';

export const MAX_TENANTS = 4;

export type TenantSplit =
  | { readonly ok: true; readonly names: string[] }
  | { readonly ok: false; readonly ambiguous: true; readonly reason: 'empty_part' | 'too_many' | 'empty' };

const TENANT_SPLIT_RE = /\s*,\s*(?:and|&)\s+|\s*,\s*|\s+(?:and|&)\s+/;

/** Split a tenants payload only on `,`, ` and `, ` & ` (incl. ", and"); 1..4 non-empty names, else ambiguous. */
export function splitTenants(payload: string): TenantSplit {
  const trimmed = payload.trim();
  if (trimmed.length === 0) return { ok: false, ambiguous: true, reason: 'empty' };
  const parts = trimmed.split(TENANT_SPLIT_RE).map((p) => p.trim());
  if (parts.some((p) => p.length === 0)) return { ok: false, ambiguous: true, reason: 'empty_part' };
  if (parts.length > MAX_TENANTS) return { ok: false, ambiguous: true, reason: 'too_many' };
  return { ok: true, names: parts };
}

const LABEL_FIELD: Readonly<Record<string, FieldKey>> = {
  landlord: 'landlord',
  tenant: 'tenants',
  tenants: 'tenants',
  guarantor: 'guarantor',
  property: 'address',
  address: 'address',
};

/** `Landlord:` `Tenants:` `Tenant:` `Guarantor:` `Property:` `Address:` */
const LABEL_RE = new RegExp(
  `(?<!\\p{L})(${ci('landlord')}|${ci('tenants')}|${ci('tenant')}|${ci('guarantor')}|${ci('property')}|${ci('address')})[ ]*:`,
  'gu',
);
/** `(the) landlord is X`, `guarantor is X`, `property is (at) X`, `address is X`; group 1 = role word. */
const IS_RE = new RegExp(
  `(?<!\\p{L})(?:${ci('the')}\\s+)?(${ci('landlord')}|${ci('guarantor')}|${ci('property')}|${ci('address')})\\s+${ci('is')}\\s+(?:${ci('at')}\\s+)?(?=[\\p{Lu}0-9])`,
  'gu',
);
/** `guarantor for <tenant> only`: an optional-term cue without a guarantor name, never a value. */
const GUARANTOR_FOR_RE = new RegExp(
  `(?<!\\p{L})${ci('guarantor')}\\s+(?=${ci('for')}(?!\\p{L}))`,
  'gu',
);
/** `property at X` */
const PROPERTY_AT_RE = new RegExp(`(?<!\\p{L})${ci('property')}\\s+${ci('at')}\\s+(?=[\\p{Lu}0-9])`, 'gu');
/** `X, the landlord` (X runs back to the previous terminator or comma); groups: 1 leading spaces, 2 X. */
const TRAILING_LANDLORD_RE = new RegExp(
  `(?<=^|[.!?;\\n,])([ ]*)([^.!?;\\n,]+?),[ ]+${ci('the')}[ ]+${ci('landlord')}(?!\\p{L})`,
  'gu',
);
/** Intro words stripped from the front of X: "it's", "it is", "this is", "I'm", "I am". */
const INTRO_RE = /^(?:[Ii]t['’]s|[Ii]t\s+is|[Tt]his\s+is|I['’]m|I\s+am)\s+/u;
/** `rent(s|ing) [<address>] to X`; groups: 1 keyword + spaces, 2 address (optional). */
const RENT_TO_RE = new RegExp(
  `(?<!\\p{L})(${ci('rent')}(?:[Ss]|${ci('ing')})?[ ]+)(?:([0-9\\p{Lu}][^.!?;\\n]*?)[ ]+)?${ci('to')}[ ]+(?=\\p{Lu})`,
  'gu',
);
/** A guarantor payload that names only some tenants ("for Joe only") is ambiguous. */
const PARTIAL_GUARANTEE_RE = /(?<!\p{L})(?:for|only)(?!\p{L})/iu;

interface RoleHit {
  readonly field: FieldKey;
  readonly span: Span;
}

/** Payload that follows a cue ending at `from`: trimmed, up to the first terminator. Null when empty. */
function followingPayload(text: string, from: number): Span | null {
  const span = trimSpan(text, from, payloadEnd(text, from));
  return span.end > span.start ? span : null;
}

function roleHits(text: string): RoleHit[] {
  const hits: RoleHit[] = [];
  for (const m of text.matchAll(LABEL_RE)) {
    const field = LABEL_FIELD[(m[1] ?? '').toLowerCase()];
    if (field === undefined) continue;
    const span = followingPayload(text, (m.index ?? 0) + m[0].length);
    if (span !== null) hits.push({ field, span });
  }
  for (const m of text.matchAll(IS_RE)) {
    const field = LABEL_FIELD[(m[1] ?? '').toLowerCase()];
    if (field === undefined) continue;
    const span = followingPayload(text, (m.index ?? 0) + m[0].length);
    if (span !== null) hits.push({ field, span });
  }
  for (const m of text.matchAll(GUARANTOR_FOR_RE)) {
    const span = followingPayload(text, (m.index ?? 0) + m[0].length);
    if (span !== null) hits.push({ field: 'guarantor', span });
  }
  for (const m of text.matchAll(PROPERTY_AT_RE)) {
    const span = followingPayload(text, (m.index ?? 0) + m[0].length);
    if (span !== null) hits.push({ field: 'address', span });
  }
  for (const m of text.matchAll(TRAILING_LANDLORD_RE)) {
    const lead = m[1] ?? '';
    const x = m[2] ?? '';
    let start = (m.index ?? 0) + lead.length;
    const intro = INTRO_RE.exec(x);
    if (intro !== null) start += intro[0].length;
    const span = trimSpan(text, start, (m.index ?? 0) + lead.length + x.length);
    if (span.end > span.start) hits.push({ field: 'landlord', span });
  }
  for (const m of text.matchAll(RENT_TO_RE)) {
    const idx = m.index ?? 0;
    const keyword = m[1] ?? '';
    const address = m[2];
    if (address !== undefined) {
      const aStart = idx + keyword.length;
      const span = trimSpan(text, aStart, aStart + address.length);
      if (span.end > span.start) hits.push({ field: 'address', span });
    }
    const span = followingPayload(text, idx + m[0].length);
    if (span !== null) hits.push({ field: 'tenants', span });
  }
  return hits;
}

export function findRoleCandidates(intake: IntakeLike): Candidate[] {
  const out: Candidate[] = [];
  for (const msg of intake.messages) {
    const text = msg.text_normalised;
    for (const hit of roleHits(text)) {
      const quote = text.slice(hit.span.start, hit.span.end);
      const base = {
        id: candidateId(hit.field, msg.id, hit.span),
        kind: 'role' as const,
        field: hit.field,
        quote,
        pointer: pointerFor(msg.id, hit.span),
      };
      if (hit.field === 'tenants') {
        const split = splitTenants(quote);
        out.push(split.ok ? { ...base, value: split.names } : { ...base, value: null, flags: ['ambiguous'] });
      } else if (hit.field === 'guarantor' && PARTIAL_GUARANTEE_RE.test(quote)) {
        out.push({ ...base, value: null, flags: ['ambiguous'] });
      } else {
        out.push({ ...base, value: quote });
      }
    }
  }
  return out;
}
