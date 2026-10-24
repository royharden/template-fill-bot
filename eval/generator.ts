// SOURCE ONLY in Dirty Mode. Labels come from these authored facts, never from an extractor, gate or renderer.
import type { GoldScenario, Label } from '../supabase/functions/_shared/evalkit/types.ts';
import type { FieldKey } from '../supabase/functions/_shared/content/types.ts';
import { shuffled } from '../supabase/functions/_shared/evalkit/random.ts';
import { splitBases } from '../supabase/functions/_shared/evalkit/split.ts';

export const GOLD_SEED = 3007;
export const AUTHORED_CLAUSES = ['parties', 'guarantor', 'property', 'unfurnished', 'term', 'break-clause', 'rent', 'rent-payment',
  'utilities-tenant-pays', 'deposit', 'deposit-return', 'use-of-property', 'pets-none', 'smoking-prohibited', 'repairs-tenant',
  'repairs-landlord', 'access-with-notice', 'quiet-enjoyment', 'ending-tenancy', 'notices'];
export function generateGold(traps: readonly GoldScenario[], seed = GOLD_SEED): { scenarios: GoldScenario[]; split: Record<string, 'dev' | 'heldout'> } {
  if (traps.length !== 20 || traps.some((s) => s.origin !== 'handtrap') || new Set(traps.map((s) => s.base_id)).size !== 20) throw new Error('twenty_distinct_handtraps_required');
  const names = shuffled(['Aster', 'Briar', 'Cedar', 'Dahlia', 'Elm', 'Fern', 'Gale', 'Hazel', 'Indigo', 'Juniper', 'Kestrel', 'Laurel', 'Maple', 'Nettle', 'Olive', 'Poppy', 'Quill', 'Rowan', 'Sorrel', 'Thistle'], seed);
  // Define and split BASES before expanding chat/email phrasing variants. Pair membership can never leak.
  const bases = names.map((name, i) => ({ base_id: `base-${String(i + 1).padStart(2, '0')}`, stratum: i < 10 ? 'ordinary' : 'higher_rent', name, rent: 900 + i * 25 }));
  const split = splitBases([...bases, ...traps.map((s) => ({ base_id: s.base_id, stratum: 'handtrap' }))], seed);
  const scenarios: GoldScenario[] = [];
  for (const base of bases) {
    const facts = { landlord: `${base.name} Vale`, tenants: [`${base.name} Reed`], address: `${11 + bases.indexOf(base)} Willow Lane`,
      start_date: '2027-03-01', term_months: 12, end_date: '2028-02-29', monthly_rent: base.rent * 100, rent_due_day: 1,
      deposit: base.rent * 100, pets: 'none', smoking: 'prohibited', furnished: 'unfurnished', utilities: ['water', 'electricity', 'gas', 'internet'], guarantor: 'Ivy Marsh', break_month: 6 };
    const fields = Object.fromEntries(Object.entries(facts).map(([key, value]) => [key, { state: 'valid', value }])) as Record<FieldKey, Label>;
    const shared = `Start date: 2027-03-01. Term: 12 months. Monthly rent: GBP ${base.rent}. Rent due day: 1. Deposit: GBP ${base.rent}. No pets. Smoking prohibited. Unfurnished. Tenant pays water, electricity, gas and internet. Guarantor: Ivy Marsh. Break clause after month 6.`;
    for (const variant of ['chat', 'email'] as const) {
      const messages = variant === 'chat' ? [{ id: 'm1', text: `Landlord: ${facts.landlord}. Tenant: ${facts.tenants[0]}. Property: ${facts.address}.` }, { id: 'm2', text: shared }] :
        [{ id: 'm1', text: `Tenancy notes\nProperty: ${facts.address}.\nTenant: ${facts.tenants[0]}.\nLandlord: ${facts.landlord}.\n${shared}` }];
      scenarios.push({ version: 1, id: `${base.base_id}-${variant}`, base_id: base.base_id, stratum: base.stratum, origin: 'generated', author: 'S30 project authors', licence: 'MIT', messages,
        expected: { fields, required_questions: [], optional_confirmation: false, clause_ids: AUTHORED_CLAUSES, unsupported_quotes: [], render_blocked: false }, tags: ['synthetic', variant] });
    }
  }
  return { scenarios: [...scenarios, ...traps], split };
}
