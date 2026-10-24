// The locked clause library (PLAN section 4.3): 27 records = 14 mandatory, 11 branch, 2 requestable.
// All text is SELF-AUTHORED, plain-English and ILLUSTRATIVE (invented, not any real law, not legal advice).
// Placeholders use `{{name}}` only for schema fields, named derived values (types.ts DERIVED_PLACEHOLDERS) or
// integer jurisdiction values; every placeholder in `text` is declared in `placeholders`.
// "Enter without notice" is deliberately absent: requesting it is the unsupported-request trap.
// Any edit here is a deliberate content change: run `npm run lock` (DV-LOCK) and review the diff.
import { CLAUSE_LICENCE, DERIVED_PLACEHOLDERS, FIELD_KIND_OF } from './types.ts';
import type {
  ClauseRecord,
  DerivedPlaceholderName,
  FieldKey,
  JurisdictionPlaceholderKey,
  PlaceholderSpec,
} from './types.ts';

const AUTHOR = 'Roy Harden';

function field(name: FieldKey): PlaceholderSpec {
  return { name, kind: FIELD_KIND_OF[name], source: 'field', from: name };
}

function derived(name: DerivedPlaceholderName): PlaceholderSpec {
  const spec = DERIVED_PLACEHOLDERS[name];
  return { name, kind: spec.kind, source: 'derived', from: spec.from };
}

function jurisdiction(name: JurisdictionPlaceholderKey): PlaceholderSpec {
  return { name, kind: 'int', source: 'jurisdiction', from: name };
}

export const CLAUSES: readonly ClauseRecord[] = [
  // --- Parties and property ---------------------------------------------------------------------------------
  {
    id: 'parties',
    version: 1,
    title: 'Parties',
    order: 10,
    category: 'mandatory',
    applies: true,
    placeholders: [field('landlord'), derived('tenants_list')],
    text:
      'This agreement is made between {{landlord}} (the Landlord) and {{tenants_list}} (the Tenant). ' +
      'Where this agreement refers to the Tenant, it means each person named as a tenant.',
    licence: CLAUSE_LICENCE,
    author: AUTHOR,
  },
  {
    id: 'joint-and-several',
    version: 1,
    title: 'Shared responsibility',
    order: 20,
    category: 'branch',
    applies: { countGte: ['tenants', 2] },
    placeholders: [],
    text:
      'Because more than one person is named as the Tenant, each of them is responsible, both together and ' +
      'individually, for paying the full rent and keeping every promise in this agreement.',
    licence: CLAUSE_LICENCE,
    author: AUTHOR,
  },
  {
    id: 'guarantor',
    version: 1,
    title: 'Guarantor',
    order: 30,
    category: 'branch',
    applies: { present: 'guarantor' },
    placeholders: [field('guarantor')],
    text:
      '{{guarantor}} (the Guarantor) agrees that if the Tenant does not pay the rent or keep the promises in ' +
      'this agreement, the Guarantor will do so when the Landlord asks in writing.',
    licence: CLAUSE_LICENCE,
    author: AUTHOR,
  },
  {
    id: 'property',
    version: 1,
    title: 'The property',
    order: 40,
    category: 'mandatory',
    applies: true,
    placeholders: [field('address')],
    text:
      'The Landlord lets to the Tenant the home at {{address}} (the Property), together with the use of any ' +
      'shared entrances and paths that lead to it.',
    licence: CLAUSE_LICENCE,
    author: AUTHOR,
  },
  {
    id: 'furnished-inventory',
    version: 1,
    title: 'Furniture and inventory',
    order: 50,
    category: 'branch',
    applies: { eq: ['furnished', 'furnished'] },
    placeholders: [],
    text:
      'The Property is let furnished. The furniture and items listed in the signed inventory are part of the ' +
      'letting, and the Tenant will hand them back at the end of the tenancy in the same condition, apart ' +
      'from fair wear and tear.',
    licence: CLAUSE_LICENCE,
    author: AUTHOR,
  },
  {
    id: 'unfurnished',
    version: 1,
    title: 'Unfurnished letting',
    order: 60,
    category: 'branch',
    applies: { eq: ['furnished', 'unfurnished'] },
    placeholders: [],
    text:
      'The Property is let unfurnished. Anything the Tenant brings into the Property remains the Tenant\'s ' +
      'own and must be removed by the end of the tenancy.',
    licence: CLAUSE_LICENCE,
    author: AUTHOR,
  },
  // --- Term ---------------------------------------------------------------------------------------------------
  {
    id: 'term',
    version: 1,
    title: 'Length of the tenancy',
    order: 70,
    category: 'mandatory',
    applies: true,
    placeholders: [field('term_months'), field('start_date'), field('end_date')],
    text:
      'The tenancy is for a fixed term of {{term_months}} months, starting on {{start_date}} and ending on ' +
      '{{end_date}}.',
    licence: CLAUSE_LICENCE,
    author: AUTHOR,
  },
  {
    id: 'break-clause',
    version: 1,
    title: 'Ending the tenancy early',
    order: 80,
    category: 'branch',
    applies: { present: 'break_month' },
    placeholders: [field('break_month')],
    text:
      'Either party may end this tenancy early, with effect from any date after the end of month ' +
      '{{break_month}} of the fixed term, by giving the other party written notice of the length the ' +
      'clause on ending the tenancy requires of that party.',
    licence: CLAUSE_LICENCE,
    author: AUTHOR,
  },
  // --- Rent, bills and deposit ----------------------------------------------------------------------------------
  {
    id: 'rent',
    version: 1,
    title: 'Rent',
    order: 90,
    category: 'mandatory',
    applies: true,
    placeholders: [field('monthly_rent')],
    text:
      'The rent is {{monthly_rent}} per month. The rent will not change during the fixed term unless both ' +
      'parties agree in writing.',
    licence: CLAUSE_LICENCE,
    author: AUTHOR,
  },
  {
    id: 'rent-payment',
    version: 1,
    title: 'Paying the rent',
    order: 100,
    category: 'mandatory',
    applies: true,
    placeholders: [derived('rent_due_day_ordinal')],
    text:
      'The Tenant will pay the rent in advance on the {{rent_due_day_ordinal}} day of each month, by bank ' +
      'transfer to an account the Landlord names in writing. The Landlord will give a receipt for any ' +
      'payment if asked.',
    licence: CLAUSE_LICENCE,
    author: AUTHOR,
  },
  {
    id: 'utilities-tenant-pays',
    version: 1,
    title: 'Bills the Tenant pays',
    order: 110,
    category: 'branch',
    applies: { nonEmpty: 'utilities' },
    placeholders: [derived('utilities_tenant_list')],
    text:
      'The Tenant is responsible for arranging and paying for the following services at the Property during ' +
      'the tenancy: {{utilities_tenant_list}}.',
    licence: CLAUSE_LICENCE,
    author: AUTHOR,
  },
  {
    id: 'utilities-included-in-rent',
    version: 1,
    title: 'Bills included in the rent',
    order: 120,
    category: 'branch',
    applies: { complementNonEmpty: 'utilities' },
    placeholders: [derived('utilities_included_list')],
    text:
      'The following services are included in the rent and are paid for by the Landlord: ' +
      '{{utilities_included_list}}.',
    licence: CLAUSE_LICENCE,
    author: AUTHOR,
  },
  {
    id: 'deposit',
    version: 1,
    title: 'Deposit',
    order: 130,
    category: 'mandatory',
    applies: true,
    placeholders: [field('deposit')],
    text:
      'The Tenant will pay a deposit of {{deposit}} before the tenancy starts. The Landlord will keep the ' +
      'deposit safe and separate from the Landlord\'s own money for the whole tenancy.',
    licence: CLAUSE_LICENCE,
    author: AUTHOR,
  },
  {
    id: 'deposit-return',
    version: 1,
    title: 'Returning the deposit',
    order: 140,
    category: 'mandatory',
    applies: true,
    placeholders: [],
    text:
      'At the end of the tenancy the Landlord will return the deposit, less any amounts the parties agree are ' +
      'owed for unpaid rent or for damage beyond fair wear and tear. The Landlord will list any deductions ' +
      'in writing.',
    licence: CLAUSE_LICENCE,
    author: AUTHOR,
  },
  // --- Living in the property ------------------------------------------------------------------------------------
  {
    id: 'use-of-property',
    version: 1,
    title: 'Using the property',
    order: 150,
    category: 'mandatory',
    applies: true,
    placeholders: [],
    text:
      'The Tenant will use the Property only as a private home. The Tenant will not run a business from it or ' +
      'sublet any part of it without the Landlord\'s written consent.',
    licence: CLAUSE_LICENCE,
    author: AUTHOR,
  },
  {
    id: 'pets-none',
    version: 1,
    title: 'No pets',
    order: 160,
    category: 'branch',
    applies: { eq: ['pets', 'none'] },
    placeholders: [],
    text: 'The Tenant will not keep any animal at the Property.',
    licence: CLAUSE_LICENCE,
    author: AUTHOR,
  },
  {
    id: 'pets-with-landlord-consent',
    version: 1,
    title: 'Pets with consent',
    order: 170,
    category: 'branch',
    applies: { eq: ['pets', 'with_consent'] },
    placeholders: [],
    text:
      'The Tenant may keep a pet at the Property only with the Landlord\'s written consent, which the ' +
      'Landlord will not refuse without good reason. The Tenant is responsible for any damage a pet causes.',
    licence: CLAUSE_LICENCE,
    author: AUTHOR,
  },
  {
    id: 'smoking-prohibited',
    version: 1,
    title: 'No smoking',
    order: 180,
    category: 'branch',
    applies: { eq: ['smoking', 'prohibited'] },
    placeholders: [],
    text: 'No one may smoke or vape anywhere at the Property.',
    licence: CLAUSE_LICENCE,
    author: AUTHOR,
  },
  {
    id: 'smoking-permitted-outside',
    version: 1,
    title: 'Smoking outside only',
    order: 190,
    category: 'branch',
    applies: { eq: ['smoking', 'permitted_outside'] },
    placeholders: [],
    text:
      'No one may smoke or vape inside the Property. Smoking is allowed only in outside areas, away from open ' +
      'windows and doors.',
    licence: CLAUSE_LICENCE,
    author: AUTHOR,
  },
  {
    id: 'garden-care',
    version: 1,
    title: 'Garden care',
    order: 200,
    category: 'requestable',
    applies: true,
    placeholders: [],
    text:
      'The Tenant will keep any garden at the Property tidy during the tenancy, including cutting the grass ' +
      'and clearing fallen leaves.',
    licence: CLAUSE_LICENCE,
    author: AUTHOR,
  },
  // --- Repairs and access -------------------------------------------------------------------------------------------
  {
    id: 'repairs-tenant',
    version: 1,
    title: 'Tenant\'s care of the property',
    order: 210,
    category: 'mandatory',
    applies: true,
    placeholders: [],
    text:
      'The Tenant will keep the inside of the Property clean, report any repair that is needed promptly and in ' +
      'writing, and put right any damage caused by the Tenant or the Tenant\'s visitors.',
    licence: CLAUSE_LICENCE,
    author: AUTHOR,
  },
  {
    id: 'repairs-landlord',
    version: 1,
    title: 'Landlord\'s repairs',
    order: 220,
    category: 'mandatory',
    applies: true,
    placeholders: [],
    text:
      'The Landlord will keep the structure and outside of the Property in repair, and will keep the ' +
      'installations for water, heating, power and sanitation in working order.',
    licence: CLAUSE_LICENCE,
    author: AUTHOR,
  },
  {
    id: 'access-with-notice',
    version: 1,
    title: 'Landlord\'s access',
    order: 230,
    category: 'mandatory',
    applies: true,
    placeholders: [jurisdiction('notice_hours_landlord_entry')],
    text:
      'The Landlord may enter the Property to inspect it or carry out repairs at a reasonable time of day, ' +
      'after giving the Tenant at least {{notice_hours_landlord_entry}} hours\' notice in writing.',
    licence: CLAUSE_LICENCE,
    author: AUTHOR,
  },
  {
    id: 'quiet-enjoyment',
    version: 1,
    title: 'Living undisturbed',
    order: 240,
    category: 'mandatory',
    applies: true,
    placeholders: [],
    text:
      'As long as the Tenant keeps the promises in this agreement, the Tenant may live in the Property for ' +
      'the whole tenancy without interruption by the Landlord.',
    licence: CLAUSE_LICENCE,
    author: AUTHOR,
  },
  // --- Ending the tenancy and notices -----------------------------------------------------------------------------
  {
    id: 'professional-clean-at-end',
    version: 1,
    title: 'Professional clean at the end',
    order: 250,
    category: 'requestable',
    applies: { eq: ['furnished', 'furnished'] },
    placeholders: [],
    text:
      'At the end of the tenancy the Tenant will have the Property, including its furniture and furnishings, ' +
      'professionally cleaned and will give the Landlord a copy of the receipt.',
    licence: CLAUSE_LICENCE,
    author: AUTHOR,
  },
  {
    id: 'ending-tenancy',
    version: 1,
    title: 'Ending the tenancy',
    order: 260,
    category: 'mandatory',
    applies: true,
    placeholders: [jurisdiction('notice_days_tenant_end'), jurisdiction('notice_days_landlord_end')],
    text:
      'The Tenant may end the tenancy at or after the end of the fixed term by giving at least ' +
      '{{notice_days_tenant_end}} days\' written notice. The Landlord may end it at or after the end of the ' +
      'fixed term by giving at least {{notice_days_landlord_end}} days\' written notice. When the tenancy ends ' +
      'the Tenant will return all keys and leave the Property clean and empty.',
    licence: CLAUSE_LICENCE,
    author: AUTHOR,
  },
  {
    id: 'notices',
    version: 1,
    title: 'Notices',
    order: 270,
    category: 'mandatory',
    applies: true,
    placeholders: [],
    text:
      'Any notice under this agreement must be in writing. It may be delivered by hand, by post or by email ' +
      'to the address the other party has given for that purpose.',
    licence: CLAUSE_LICENCE,
    author: AUTHOR,
  },
];
