// Enum cue-sentence candidates (PLAN sections 4.1, 4.4, K8, K9): pets, smoking, furnished, utilities.
// The quote of an enum candidate is the whole sentence (terminator excluded) so grounding can see both the
// cue word and any qualifier. The classifiers are exported and reused by the field parsers (fields.ts).
//
// pets      none:          "no pets", "no animals", "pets not allowed/permitted", "pets prohibited/banned"
//           with_consent:  "pets allowed/permitted", "with (the landlord's) consent", "can keep" (pet word needed)
//           a qualifier ("except", "only", "but") in the same sentence -> ambiguous + residual text after it.
// smoking   prohibited:        "no smoking", "smoking prohibited/banned/not allowed", "non-smoking"
//           permitted_outside: "smoking outside", "smoking (allowed) outside", "can smoke outside"
// furnished furnished: "furnished" (also "furnished yes"); unfurnished: "unfurnished", "not furnished",
//           "furnished: no"; "part/partly/semi furnished" -> ambiguous. "unfurnished" never counts as furnished.
// Contradictory cues in one sentence -> ambiguous with value null.
// utilities each category mention (water / electricity|electric / gas / internet|broadband|wifi) is assigned
//           to the nearest cue in the sentence: tenant-pays ("tenant(s) pay", "paid by the tenant") or included
//           ("included", "landlord pays"); "all bills/utilities" with a cue and no category -> all four.
import { UTILITY_CATEGORIES } from '../../content/types.ts';
import type { FieldKey, UtilityCategory } from '../../content/types.ts';
import type { IntakeLike } from '../normalize.ts';
import type { Candidate } from '../schema.ts';
import { candidateId, findCues, pointerFor, sentenceSpans, trimSpan } from './text.ts';
import type { CueHit, CueRule, Span } from './text.ts';

export const PETS_VALUES = ['none', 'with_consent'] as const;
export const SMOKING_VALUES = ['prohibited', 'permitted_outside'] as const;
export const FURNISHED_VALUES = ['furnished', 'unfurnished'] as const;
export type PetsValue = (typeof PETS_VALUES)[number];
export type SmokingValue = (typeof SMOKING_VALUES)[number];
export type FurnishedValue = (typeof FURNISHED_VALUES)[number];

export interface EnumClassification<V extends string> {
  /** null when the cues contradict each other (or the sentence is only "part furnished"). */
  readonly value: V | null;
  readonly ambiguous: boolean;
  /** Offsets RELATIVE to the classified text of the qualifier residual ("a small cat"), if any. */
  readonly residual: Span | null;
}

const anyMatch = (res: readonly RegExp[], s: string): boolean => res.some((re) => re.test(s));

// --- pets (regexes below are non-global and used with .test only)
const PET_WORD_RE = /\b(?:pets?|animals?|cats?|dogs?)\b/i;
const PETS_NONE_RES = [
  /\bno\s+(?:pets|animals)\b/i,
  /\b(?:pets?|animals?)\s+(?:are\s+|is\s+)?not\s+(?:allowed|permitted)\b/i,
  /\b(?:pets|animals)\s+(?:are\s+)?(?:prohibited|forbidden|banned)\b/i,
];
const PETS_CONSENT_RES = [/(?<!\bno\s+)\b(?:pets?|animals?)\s+(?:are\s+|is\s+)?(?:allowed|permitted)\b/i];
const PETS_CONSENT_NEEDS_PET_WORD_RES = [/\bwith\s+(?:the\s+)?(?:landlord['’]s\s+)?consent\b/i, /\bcan\s+keep\b/i];
const PETS_QUALIFIER_RE = /\b(?:except|only|but)\b/i;

function residualAfter(text: string, re: RegExp): Span | null {
  const m = re.exec(text);
  if (m === null) return null;
  const span = trimSpan(text, m.index + m[0].length, text.length);
  return span.end > span.start ? span : null;
}

export function classifyPets(text: string): EnumClassification<PetsValue> | null {
  const none = anyMatch(PETS_NONE_RES, text);
  const consent =
    anyMatch(PETS_CONSENT_RES, text) || (PET_WORD_RE.test(text) && anyMatch(PETS_CONSENT_NEEDS_PET_WORD_RES, text));
  if (!none && !consent) return null;
  if (none && consent) return { value: null, ambiguous: true, residual: null };
  const value: PetsValue = none ? 'none' : 'with_consent';
  if (PETS_QUALIFIER_RE.test(text)) return { value, ambiguous: true, residual: residualAfter(text, PETS_QUALIFIER_RE) };
  return { value, ambiguous: false, residual: null };
}

// --- smoking
const SMOKING_PROHIBITED_RES = [
  /\bno\s+smok(?:ing|ers)\b/i,
  /\bsmoking\s+(?:is\s+)?(?:prohibited|forbidden|banned|not\s+(?:allowed|permitted))\b/i,
  /\bnon[\s-]?smoking\b/i,
];
const SMOKING_OUTSIDE_RES = [
  /\bsmoking\s+(?:is\s+)?(?:only\s+)?(?:allowed\s+|permitted\s+|ok\s+|fine\s+)?(?:only\s+)?outside\b/i,
  /\bsmoke\s+(?:only\s+)?outside\b/i,
];

export function classifySmoking(text: string): EnumClassification<SmokingValue> | null {
  const prohibited = anyMatch(SMOKING_PROHIBITED_RES, text);
  const outside = anyMatch(SMOKING_OUTSIDE_RES, text);
  if (!prohibited && !outside) return null;
  if (prohibited && outside) return { value: null, ambiguous: true, residual: null };
  return { value: prohibited ? 'prohibited' : 'permitted_outside', ambiguous: false, residual: null };
}

// --- furnished
const UNFURNISHED_RES = [/\bunfurnished\b/i, /\bnot\s+furnished\b/i, /\bfurnished\s*[:-]?\s*no(?=\s*(?:[,.;!?\n]|$))/i];
const PART_FURNISHED_RE = /\b(?:part|partly|partially|semi)[\s-]*furnished\b/i;
/** "furnished" that is not "unfurnished", "not furnished", "part furnished" or "furnished: no". */
const FURNISHED_RE =
  /(?<![\p{L}-])(?<!\bnot\s+)(?<!\b(?:part|partly|partially|semi)[\s-]*)furnished\b(?!\s*[:-]?\s*no(?=\s*(?:[,.;!?\n]|$)))/iu;

export function classifyFurnished(text: string): EnumClassification<FurnishedValue> | null {
  const part = PART_FURNISHED_RE.test(text);
  const unf = anyMatch(UNFURNISHED_RES, text);
  const furn = FURNISHED_RE.test(text);
  if (!part && !unf && !furn) return null;
  if (part || (unf && furn)) return { value: null, ambiguous: true, residual: null };
  return { value: unf ? 'unfurnished' : 'furnished', ambiguous: false, residual: null };
}

// --- utilities
type UtilityCue = 'tenant_pays' | 'included';
const UTILITY_MENTION_RE = /\b(water|electricity|electric|gas|internet|broadband|wi-?fi)\b/gi;
const GENERIC_BILLS_RE = /\b(?:bills|utilities)\b/i;
const UTILITY_CUES: readonly CueRule<UtilityCue>[] = [
  {
    tag: 'tenant_pays',
    re: /\b(?:tenants?\s+(?:will\s+|must\s+|to\s+)?(?:pay|pays|paying|cover|covers|(?:is\s+|are\s+)?responsible\s+for)|paid\s+by\s+(?:the\s+)?tenants?|tenants?['’]s?\s+responsibility)\b/gi,
  },
  { tag: 'included', re: /\b(?:included|includes|including|inclusive|landlord\s+(?:pays|covers|will\s+pay))\b/gi },
];

export function utilityCategoryOf(token: string): UtilityCategory | null {
  const t = token.toLowerCase();
  if (t === 'water') return 'water';
  if (t === 'electricity' || t === 'electric') return 'electricity';
  if (t === 'gas') return 'gas';
  if (t === 'internet' || t === 'broadband' || t === 'wifi' || t === 'wi-fi') return 'internet';
  return null;
}

/** Order a category list by the closed list order (water, electricity, gas, internet), deduplicated. */
export function canonicalUtilities(list: readonly UtilityCategory[]): UtilityCategory[] {
  return UTILITY_CATEGORIES.filter((c) => list.includes(c));
}

export interface UtilitiesClassification {
  readonly tenant_pays: UtilityCategory[];
  readonly included: UtilityCategory[];
  /** A category was assigned to both sides in this text. Such categories are left out of both lists. */
  readonly ambiguous: boolean;
}

function nearestHit(hits: readonly CueHit<UtilityCue>[], at: Span): UtilityCue | null {
  let best: { tag: UtilityCue; dist: number } | null = null;
  for (const h of hits) {
    let dist: number;
    if (h.end <= at.start) dist = at.start - h.end;
    else if (h.start >= at.end) dist = h.start - at.end;
    else continue;
    if (best === null || dist < best.dist) best = { tag: h.tag, dist };
  }
  return best === null ? null : best.tag;
}

/** Partial classification of one sentence; null when no category is classified. */
export function classifyUtilities(text: string): UtilitiesClassification | null {
  const whole: Span = { start: 0, end: text.length };
  const hits = findCues(text, whole, UTILITY_CUES);
  if (hits.length === 0) return null;
  const tenant = new Set<UtilityCategory>();
  const included = new Set<UtilityCategory>();
  let mentions = 0;
  for (const m of text.matchAll(UTILITY_MENTION_RE)) {
    const cat = utilityCategoryOf(m[1] ?? '');
    if (cat === null) continue;
    mentions++;
    const start = m.index ?? 0;
    const cue = nearestHit(hits, { start, end: start + m[0].length });
    if (cue === 'tenant_pays') tenant.add(cat);
    else if (cue === 'included') included.add(cat);
  }
  if (mentions === 0 && GENERIC_BILLS_RE.test(text)) {
    const tags = new Set(hits.map((h) => h.tag));
    if (tags.size === 1) {
      const target = tags.has('tenant_pays') ? tenant : included;
      for (const c of UTILITY_CATEGORIES) target.add(c);
    }
  }
  const both = [...tenant].filter((c) => included.has(c));
  for (const c of both) {
    tenant.delete(c);
    included.delete(c);
  }
  if (tenant.size === 0 && included.size === 0) return null;
  return {
    tenant_pays: canonicalUtilities([...tenant]),
    included: canonicalUtilities([...included]),
    ambiguous: both.length > 0,
  };
}

// --- finder

interface EnumRule {
  readonly field: FieldKey;
  readonly classify: (s: string) => EnumClassification<string> | null;
}
const ENUM_RULES: readonly EnumRule[] = [
  { field: 'pets', classify: classifyPets },
  { field: 'smoking', classify: classifySmoking },
  { field: 'furnished', classify: classifyFurnished },
];

export function findEnumCandidates(intake: IntakeLike): Candidate[] {
  const out: Candidate[] = [];
  for (const msg of intake.messages) {
    const text = msg.text_normalised;
    for (const sentence of sentenceSpans(text)) {
      const s = text.slice(sentence.start, sentence.end);
      const pointer = pointerFor(msg.id, sentence);
      for (const rule of ENUM_RULES) {
        const cls = rule.classify(s);
        if (cls === null) continue;
        const c: Candidate = {
          id: candidateId(rule.field, msg.id, sentence),
          kind: 'enum',
          field: rule.field,
          value: cls.value,
          quote: s,
          pointer,
        };
        if (cls.ambiguous) c.flags = ['ambiguous'];
        if (cls.residual !== null) {
          const abs: Span = { start: sentence.start + cls.residual.start, end: sentence.start + cls.residual.end };
          c.residual = { quote: text.slice(abs.start, abs.end), pointer: pointerFor(msg.id, abs) };
        }
        out.push(c);
      }
      const util = classifyUtilities(s);
      if (util !== null) {
        const c: Candidate = {
          id: candidateId('utilities', msg.id, sentence),
          kind: 'utilities',
          field: 'utilities',
          value: { tenant_pays: util.tenant_pays, included: util.included },
          quote: s,
          pointer,
        };
        if (util.ambiguous) c.flags = ['ambiguous'];
        out.push(c);
      }
    }
  }
  return out;
}
