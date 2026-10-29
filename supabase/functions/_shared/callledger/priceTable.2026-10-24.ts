import type { PriceTable } from './types.ts';

/** Construction placeholders, NOT current prices. No live rate was verified in Dirty Mode.
 * Empty live entries deliberately make every paid model fail with price_missing until DV-PROVIDERS.
 * The zero-cost mock entry is labelled and never presented as measured provider usage.
 * Jev's proposed output rate is zero; add the input rate only after checking current billing docs.
 */
export const PRICE_TABLE: PriceTable = {
  date: '2026-10-24',
  entries: [{ provider: 'mock', model: 'mock', input_usd_per_million: 0, output_usd_per_million: 0, verified: true }],
};
