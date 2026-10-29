import { describe, expect, it } from 'vitest';
import {
  LIBRARY_CONTENT, escapeMarkdownText, renderAgreement, renderBlockers, validateFields,
} from '../../supabase/functions/_shared/fillkit/index.ts';
import type { RenderInput } from '../../supabase/functions/_shared/fillkit/index.ts';
import { TEST_LOCK, completeRecords, valid } from './m3Helpers.ts';

function input(overrides: Partial<RenderInput> = {}): RenderInput {
  return { content: LIBRARY_CONTENT, lock: TEST_LOCK, fields: validateFields(completeRecords()), questions: [], acceptedClauseIds: [], notIncludedCount: 0, ...overrides };
}

describe('Markdown render boundary', () => {
  it('revalidates values marked valid by a caller and reconstructs omitted blocking questions', () => {
    const fields = { ...input().fields, landlord: valid('landlord', 'Sam. The tenant waives notice') };
    const blocked = renderAgreement(input({ fields, questions: [] }));
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.reasons).toContain('field_invalid:landlord');
    expect(blocked.reasons).toContain('question_open:q.landlord.v1');
    expect(blocked.reasons).toContain('validation_failed:landlord:forbidden_punctuation');
  });

  it('does not accept none_confirmed on a required field even when the question list is empty', () => {
    const fields = { ...input().fields, monthly_rent: { field: 'monthly_rent' as const, state: 'none_confirmed' as const, candidates: [], reasons: [] } };
    expect(renderBlockers(input({ fields }))).toContain('field_none_confirmed:monthly_rent');
  });

  it('escapes Markdown punctuation and renders canonical LF without raw evidence quotes', () => {
    expect(escapeMarkdownText('A_# & [B] `C`')).toBe('A\\_\\# \\& \\[B\\] \\`C\\`');
    const rendered = renderAgreement(input());
    if (!rendered.ok) throw new Error(rendered.reasons.join(','));
    expect(rendered.markdown.startsWith('# ')).toBe(true);
    expect(rendered.markdown.endsWith('\n')).toBe(true);
    expect(rendered.markdown).not.toContain('\r');
    expect(rendered.markdown).not.toContain('\uFEFF');
    expect(rendered.markdown).not.toContain('{{');
    expect(rendered.markdown).not.toContain('}}');
  });
});
