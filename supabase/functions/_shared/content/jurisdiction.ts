// Illustrative jurisdiction config (PLAN section 4.2). Every value here is an INVENTED EXAMPLE VALUE,
// NOT ANY REAL LAW. Changing any value is a deliberate content change: run `npm run lock` and review the diff.
import type { Jurisdiction } from './types.ts';

export const JURISDICTION: Jurisdiction = {
  id: 'illustrative-1',
  version: 1,
  label: 'Illustrative jurisdiction: invented example values, not any real law',
  currency: { code: 'GBP', symbol: '£' },
  deposit_cap_weeks: 5,
  term_months_min: 6,
  term_months_max: 36,
  due_day_min: 1,
  due_day_max: 28,
  notice_hours_landlord_entry: 24,
  notice_days_tenant_end: 30,
  notice_days_landlord_end: 60,
};
