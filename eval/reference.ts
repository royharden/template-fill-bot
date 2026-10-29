// Gold labels are supplied by authors, never extracted by the method under evaluation.
// These records exist solely to render the whitelist for paragraph equality, not to score extraction.
import { FIELD_KEYS } from '../supabase/functions/_shared/content/types.ts';
import type { FieldKey } from '../supabase/functions/_shared/content/types.ts';
import type { GroundedField } from '../supabase/functions/_shared/fillkit/grounding.ts';
import { LIBRARY_CONTENT } from '../supabase/functions/_shared/fillkit/library.ts';
import { clauseSegments } from '../supabase/functions/_shared/fillkit/segments.ts';
import type { GoldScenario } from '../supabase/functions/_shared/evalkit/types.ts';

/** Exact locked standalone frame paragraphs only. Dynamic appendix rows and unknown headings are never exempted. */
export function knownBoilerplate(): string[] {
  return LIBRARY_CONTENT.frame.filter((frame) => frame.placeholders.length === 0 && ['title', 'heading', 'notice', 'sentence', 'appendix_label'].includes(frame.kind))
    .flatMap((frame) => [frame.text, ...(frame.kind === 'title' ? [`# ${frame.text}`] : frame.kind === 'heading' || frame.id === 'appendix-heading' ? [`## ${frame.text}`] : [])]);
}

export function renderedWhitelist(scenario: GoldScenario): string[] {
  const fields = Object.fromEntries(FIELD_KEYS.map((key) => {
    const label = scenario.expected.fields[key];
    return [key, { field: key, state: label?.state ?? 'missing', ...(label?.value === undefined ? {} : { value: label.value }), candidates: [], reasons: [] }];
  })) as Record<FieldKey, GroundedField>;
  return LIBRARY_CONTENT.clauses.flatMap((clause) => {
    try { return [clauseSegments(LIBRARY_CONTENT, clause, fields).map((s) => s.text).join('')]; } catch { return []; }
  });
}
