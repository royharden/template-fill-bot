// Aggregate every candidate finder (PLAN section 4.4). Output order is deterministic: message order, then
// span start, then span end, then id. Duplicate ids (the same span found by two patterns) are kept once
// (first finder in FINDERS order wins).
import { parsePointer } from '../cited.ts';
import type { IntakeLike } from '../normalize.ts';
import type { Candidate, RequestCandidate } from '../schema.ts';
import { findDateCandidates } from './dates.ts';
import { findDueDayCandidates } from './dueDay.ts';
import { findDurationCandidates } from './durations.ts';
import { findEnumCandidates } from './enums.ts';
import { findMoneyCandidates } from './money.ts';
import { findRequestCandidates } from './requests.ts';
import { findRoleCandidates } from './roles.ts';

export { findDateCandidates, parseDateText, isValidIsoDate, MONTH_ALT } from './dates.ts';
export { findDueDayCandidates, parseDueDayText } from './dueDay.ts';
export { findDurationCandidates, parseDurationText } from './durations.ts';
export {
  findEnumCandidates,
  classifyPets,
  classifySmoking,
  classifyFurnished,
  classifyUtilities,
  canonicalUtilities,
  PETS_VALUES,
  SMOKING_VALUES,
  FURNISHED_VALUES,
} from './enums.ts';
export { findMoneyCandidates, parseMoneyText, parseRelativeDepositText, MAX_MONEY_MINOR } from './money.ts';
export { findRequestCandidates, REQUEST_DETECTORS } from './requests.ts';
export { findRoleCandidates, splitTenants, MAX_TENANTS } from './roles.ts';

export interface AllCandidates {
  readonly candidates: Candidate[];
  readonly requests: RequestCandidate[];
}

const FINDERS: readonly ((intake: IntakeLike) => Candidate[])[] = [
  findRoleCandidates,
  findDateCandidates,
  findDurationCandidates,
  findMoneyCandidates,
  findDueDayCandidates,
  findEnumCandidates,
];

function sortKey(intake: IntakeLike, pointer: string): [number, number, number] {
  const p = parsePointer(pointer);
  if (p === null) return [Number.MAX_SAFE_INTEGER, 0, 0];
  const idx = intake.messages.findIndex((m) => m.id === p.message_id);
  return [idx < 0 ? Number.MAX_SAFE_INTEGER : idx, p.start, p.end];
}

function byPosition<T extends { readonly id: string; readonly pointer: string }>(intake: IntakeLike, items: T[]): T[] {
  const keyed = items.map((item) => ({ item, key: sortKey(intake, item.pointer) }));
  keyed.sort(
    (a, b) =>
      a.key[0] - b.key[0] ||
      a.key[1] - b.key[1] ||
      a.key[2] - b.key[2] ||
      (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0),
  );
  return keyed.map((k) => k.item);
}

function dedupe<T extends { readonly id: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

export function findAllCandidates(intake: IntakeLike): AllCandidates {
  const all: Candidate[] = [];
  for (const finder of FINDERS) all.push(...finder(intake));
  return {
    candidates: byPosition(intake, dedupe(all)),
    requests: byPosition(intake, dedupe(findRequestCandidates(intake))),
  };
}
