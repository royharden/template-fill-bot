// Locked frame records (PLAN section 4.3): document text that is not a clause. Self-authored, illustrative.
// Headings carry `from_order` (see FrameRecord in types.ts). Join tokens and the "requests were not included"
// sentences are locked here so that neither the renderer nor the gate ever invents connecting text.
// Any edit here is a deliberate content change: run `npm run lock` (DV-LOCK) and review the diff.
import { METHOD_TOKENS } from './types.ts';
import type { FrameRecord } from './types.ts';

export const FRAME: readonly FrameRecord[] = [
  // --- Document opening ----------------------------------------------------------------------------------------
  {
    id: 'title',
    version: 1,
    kind: 'title',
    text: 'Residential Tenancy Agreement (Illustrative Draft)',
    placeholders: [],
  },
  {
    id: 'draft-notice',
    version: 1,
    kind: 'notice',
    text:
      'DRAFT, NOT LEGAL ADVICE. This document was assembled from a fixed library of illustrative clauses ' +
      'using invented example rules that do not reflect any real law. Have it reviewed by a qualified lawyer ' +
      'before anyone relies on it.',
    placeholders: [],
  },
  {
    id: 'jurisdiction-notice',
    version: 1,
    kind: 'notice',
    text: 'Illustrative jurisdiction: invented example values, not any real law.',
    placeholders: [],
  },
  // --- Section headings (from_order = first clause order covered by the section) --------------------------------
  {
    id: 'heading-parties-property',
    version: 1,
    kind: 'heading',
    text: 'Parties and property',
    placeholders: [],
    from_order: 10,
  },
  {
    id: 'heading-term',
    version: 1,
    kind: 'heading',
    text: 'Term',
    placeholders: [],
    from_order: 70,
  },
  {
    id: 'heading-rent-bills-deposit',
    version: 1,
    kind: 'heading',
    text: 'Rent, bills and deposit',
    placeholders: [],
    from_order: 90,
  },
  {
    id: 'heading-living',
    version: 1,
    kind: 'heading',
    text: 'Living in the property',
    placeholders: [],
    from_order: 150,
  },
  {
    id: 'heading-repairs-access',
    version: 1,
    kind: 'heading',
    text: 'Repairs and access',
    placeholders: [],
    from_order: 210,
  },
  {
    id: 'heading-ending-notices',
    version: 1,
    kind: 'heading',
    text: 'Ending the tenancy and notices',
    placeholders: [],
    from_order: 250,
  },
  // --- List join tokens (utilities and tenant lists): "a", "a and b", "a, b and c" ---------------------------
  {
    id: 'join-list-separator',
    version: 1,
    kind: 'join_token',
    text: ', ',
    placeholders: [],
  },
  {
    id: 'join-list-final',
    version: 1,
    kind: 'join_token',
    text: ' and ',
    placeholders: [],
  },
  // --- Unsupported requests (request text itself never enters the agreement files) -----------------------------
  {
    id: 'requests-not-included-one',
    version: 1,
    kind: 'sentence',
    text: '1 request was not included; see provenance file.',
    placeholders: [],
  },
  {
    id: 'requests-not-included-many',
    version: 1,
    kind: 'sentence',
    text: '{{n}} requests were not included; see provenance file.',
    placeholders: [{ name: 'n', kind: 'int', meaning: 'count of requests not included, 2 or more' }],
  },
  // --- Appendix --------------------------------------------------------------------------------------------------
  {
    id: 'method-tokens',
    version: 1,
    kind: 'token_list',
    text: 'Closed list of method tokens shown in the appendix for each field value.',
    placeholders: [],
    tokens: [...METHOD_TOKENS],
  },
  {
    id: 'appendix-heading',
    version: 1,
    kind: 'appendix_label',
    text: 'Appendix: how this draft was assembled',
    placeholders: [],
  },
  {
    id: 'appendix-label-field-values',
    version: 1,
    kind: 'appendix_label',
    text: 'Field values',
    placeholders: [],
  },
  {
    id: 'appendix-label-field',
    version: 1,
    kind: 'appendix_label',
    text: 'Field',
    placeholders: [],
  },
  {
    id: 'appendix-label-value',
    version: 1,
    kind: 'appendix_label',
    text: 'Value',
    placeholders: [],
  },
  {
    id: 'appendix-label-method',
    version: 1,
    kind: 'appendix_label',
    text: 'Method',
    placeholders: [],
  },
  {
    id: 'appendix-label-pointer',
    version: 1,
    kind: 'appendix_label',
    text: 'Source pointer',
    placeholders: [],
  },
  {
    id: 'appendix-label-clauses',
    version: 1,
    kind: 'appendix_label',
    text: 'Clauses used',
    placeholders: [],
  },
  {
    id: 'appendix-label-clause-version',
    version: 1,
    kind: 'appendix_label',
    text: 'Version',
    placeholders: [],
  },
  {
    id: 'appendix-label-library-hash',
    version: 1,
    kind: 'appendix_label',
    text: 'Clause library hash',
    placeholders: [],
  },
  {
    id: 'appendix-label-jurisdiction-hash',
    version: 1,
    kind: 'appendix_label',
    text: 'Jurisdiction config hash',
    placeholders: [],
  },
  {
    id: 'appendix-label-content-hash',
    version: 1,
    kind: 'appendix_label',
    text: 'Agreement content hash',
    placeholders: [],
  },
];
