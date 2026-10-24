import { describe, expect, it } from 'vitest';
import {
  LIBRARY_CONTENT,
  computeLock,
  loadLibrary,
  validateContent,
  verifyLibrary,
} from '../../supabase/functions/_shared/fillkit/library.ts';
import { LIBRARY_LOCK } from '../../supabase/functions/_shared/content/library.lock.ts';
import type {
  ClauseRecord,
  FrameRecord,
  LibraryContent,
  LockedLibraryLock,
  Predicate,
} from '../../supabase/functions/_shared/content/types.ts';

const HEX64 = /^[0-9a-f]{64}$/;

function clause(id: string): ClauseRecord {
  const found = LIBRARY_CONTENT.clauses.find((c) => c.id === id);
  if (found === undefined) throw new Error(`test setup: no clause ${id}`);
  return found;
}

function withClause(id: string, patch: Partial<ClauseRecord>): LibraryContent {
  return {
    ...LIBRARY_CONTENT,
    clauses: LIBRARY_CONTENT.clauses.map((c) => (c.id === id ? { ...c, ...patch } : c)),
  };
}

function withFrame(id: string, patch: Partial<FrameRecord>): LibraryContent {
  return {
    ...LIBRARY_CONTENT,
    frame: LIBRARY_CONTENT.frame.map((r) => (r.id === id ? { ...r, ...patch } : r)),
  };
}

function reasonsOf(content: LibraryContent, lock: LockedLibraryLock): readonly string[] {
  const result = verifyLibrary(content, lock);
  if (result.ok) throw new Error('expected verification to fail');
  return result.reasons;
}

const UNLOCKED = { status: 'UNLOCKED', note: 'test sentinel' } as const;

describe('UNLOCKED sentinel (fail-closed)', () => {
  it('blocks with exactly reasons ["library_unlocked"] for valid content', () => {
    expect(verifyLibrary(LIBRARY_CONTENT, UNLOCKED)).toEqual({ ok: false, reasons: ['library_unlocked'] });
  });

  it('keeps content problems visible alongside library_unlocked', () => {
    const broken = withClause('parties', { applies: { present: 'guarantor' } });
    const result = verifyLibrary(broken, UNLOCKED);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons[0]).toBe('library_unlocked');
      expect(result.reasons.some((r) => r.startsWith('content_invalid:clause:parties'))).toBe(true);
    }
  });

  it('the committed lock either is the sentinel (blocks) or matches the content exactly', () => {
    const { verification } = loadLibrary();
    if (LIBRARY_LOCK.status === 'UNLOCKED') {
      // Dirty Mode state until DV-LOCK.
      expect(verification).toEqual({ ok: false, reasons: ['library_unlocked'] });
    } else {
      // After DV-LOCK: any drift between committed content and committed lock fails this test.
      expect(verification).toEqual({ ok: true, lock: computeLock(LIBRARY_CONTENT) });
    }
  });
});

describe('computeLock', () => {
  it('the committed content is statically valid', () => {
    expect(validateContent(LIBRARY_CONTENT)).toEqual([]);
  });

  it('is deterministic (same content -> identical lock)', () => {
    expect(computeLock(LIBRARY_CONTENT)).toEqual(computeLock(LIBRARY_CONTENT));
    expect(computeLock(structuredClone(LIBRARY_CONTENT) as LibraryContent)).toEqual(computeLock(LIBRARY_CONTENT));
  });

  it('does not depend on object key order in the source records', () => {
    const reordered: LibraryContent = {
      jurisdiction: Object.fromEntries(Object.entries(LIBRARY_CONTENT.jurisdiction).reverse()) as never,
      frame: LIBRARY_CONTENT.frame.map((r) => Object.fromEntries(Object.entries(r).reverse()) as never),
      clauses: LIBRARY_CONTENT.clauses.map((c) => Object.fromEntries(Object.entries(c).reverse()) as never),
    };
    expect(computeLock(reordered)).toEqual(computeLock(LIBRARY_CONTENT));
  });

  it('hashes every clause and frame record with 64-hex digests', () => {
    const lock = computeLock(LIBRARY_CONTENT);
    expect(lock.status).toBe('LOCKED');
    expect(lock.version).toBe(1);
    expect(Object.keys(lock.clauses).sort()).toEqual(LIBRARY_CONTENT.clauses.map((c) => c.id).sort());
    expect(Object.keys(lock.frame).sort()).toEqual(LIBRARY_CONTENT.frame.map((r) => r.id).sort());
    for (const digest of [...Object.values(lock.clauses), ...Object.values(lock.frame)]) {
      expect(digest).toMatch(HEX64);
    }
    expect(lock.jurisdiction).toMatch(HEX64);
    expect(lock.overall).toMatch(HEX64);
    expect(new Set(Object.values(lock.clauses)).size).toBe(LIBRARY_CONTENT.clauses.length);
  });

  it('rejects duplicate ids (a map keyed by id cannot represent them)', () => {
    const dup: LibraryContent = { ...LIBRARY_CONTENT, clauses: [...LIBRARY_CONTENT.clauses, clause('notices')] };
    expect(() => computeLock(dup)).toThrow(/duplicate clause id notices/);
  });

  it('a lock computed from the content verifies', () => {
    const lock = computeLock(LIBRARY_CONTENT);
    expect(verifyLibrary(LIBRARY_CONTENT, lock)).toEqual({ ok: true, lock });
  });
});

describe('editing a clause changes its hash and the overall hash, and verification names the record', () => {
  const base = computeLock(LIBRARY_CONTENT);
  const reversedPlaceholders = [...clause('term').placeholders].reverse();
  const edits: ReadonlyArray<readonly [string, string, Partial<ClauseRecord>]> = [
    ['text', 'parties', { text: `${clause('parties').text} Both parties keep a signed copy.` }],
    ['order', 'notices', { order: 275 }],
    ['applies', 'pets-none', { applies: { eq: ['pets', 'with_consent'] } }],
    ['category', 'garden-care', { category: 'branch' }],
    ['placeholders', 'term', { placeholders: reversedPlaceholders }],
    ['title', 'rent', { title: 'The rent' }],
    ['version', 'deposit', { version: 2 }],
  ];

  for (const [what, id, patch] of edits) {
    it(`${what} (${id})`, () => {
      const edited = withClause(id, patch);
      const next = computeLock(edited);
      expect(next.clauses[id]).not.toBe(base.clauses[id]);
      for (const other of Object.keys(base.clauses)) {
        if (other !== id) expect(next.clauses[other]).toBe(base.clauses[other]);
      }
      expect(next.frame).toEqual(base.frame);
      expect(next.jurisdiction).toBe(base.jurisdiction);
      expect(next.overall).not.toBe(base.overall);

      const reasons = reasonsOf(edited, base);
      expect(reasons).toContain(`clause_hash_mismatch:${id}`);
      expect(reasons).toContain('overall_hash_mismatch');
    });
  }
});

describe('editing frame or jurisdiction', () => {
  const base = computeLock(LIBRARY_CONTENT);

  it('frame text edit changes only that frame hash and the overall hash', () => {
    const edited = withFrame('draft-notice', { text: 'DRAFT. Edited notice.' });
    const next = computeLock(edited);
    expect(next.frame['draft-notice']).not.toBe(base.frame['draft-notice']);
    expect(next.clauses).toEqual(base.clauses);
    expect(next.overall).not.toBe(base.overall);
    expect(reasonsOf(edited, base)).toContain('frame_hash_mismatch:draft-notice');
  });

  it('join token edit is caught', () => {
    const edited = withFrame('join-list-final', { text: ' & ' });
    expect(reasonsOf(edited, base)).toContain('frame_hash_mismatch:join-list-final');
  });

  it('jurisdiction edit changes the jurisdiction hash and the overall hash only', () => {
    const edited: LibraryContent = {
      ...LIBRARY_CONTENT,
      jurisdiction: { ...LIBRARY_CONTENT.jurisdiction, notice_hours_landlord_entry: 48 },
    };
    const next = computeLock(edited);
    expect(next.jurisdiction).not.toBe(base.jurisdiction);
    expect(next.clauses).toEqual(base.clauses);
    expect(next.frame).toEqual(base.frame);
    expect(next.overall).not.toBe(base.overall);
    const reasons = reasonsOf(edited, base);
    expect(reasons).toContain('jurisdiction_hash_mismatch');
    expect(reasons).toContain('overall_hash_mismatch');
  });
});

describe('lock drift and tampering', () => {
  const base = computeLock(LIBRARY_CONTENT);

  it('a clause removed from the content is reported as an extra lock entry', () => {
    const edited: LibraryContent = {
      ...LIBRARY_CONTENT,
      clauses: LIBRARY_CONTENT.clauses.filter((c) => c.id !== 'garden-care'),
    };
    expect(reasonsOf(edited, base)).toContain('lock_extra_clause:garden-care');
  });

  it('a clause added to the content is reported as missing from the lock', () => {
    const added: ClauseRecord = { ...clause('garden-care'), id: 'window-cleaning', order: 205, title: 'Windows' };
    const edited: LibraryContent = { ...LIBRARY_CONTENT, clauses: [...LIBRARY_CONTENT.clauses, added] };
    expect(reasonsOf(edited, base)).toContain('lock_missing_clause:window-cleaning');
  });

  it('a hand-edited overall hash is caught', () => {
    const tampered: LockedLibraryLock = { ...base, overall: '0'.repeat(64) };
    expect(reasonsOf(LIBRARY_CONTENT, tampered)).toEqual(['overall_hash_mismatch']);
  });

  it('a lock whose clause entry was updated without updating overall is caught', () => {
    const edited = withClause('rent', { title: 'The rent' });
    const partial: LockedLibraryLock = {
      ...base,
      clauses: { ...base.clauses, rent: computeLock(edited).clauses.rent },
    };
    expect(reasonsOf(edited, partial)).toEqual(['overall_hash_mismatch']);
  });

  it('malformed digests are rejected', () => {
    const malformed: LockedLibraryLock = { ...base, clauses: { ...base.clauses, parties: 'xyz' } };
    expect(reasonsOf(LIBRARY_CONTENT, malformed)).toContain('lock_malformed:clauses.parties');
  });

  it('an unsupported lock version is rejected', () => {
    const future: LockedLibraryLock = { ...base, version: 2 };
    expect(reasonsOf(LIBRARY_CONTENT, future)[0]).toBe('lock_version_unsupported:2');
  });
});

describe('static content validation', () => {
  const base = computeLock(LIBRARY_CONTENT);

  function problems(content: LibraryContent): string[] {
    return validateContent(content);
  }

  it('undeclared placeholder in text', () => {
    const edited = withClause('parties', { text: `${clause('parties').text} Signed {{sign_date}}.` });
    expect(problems(edited)).toContain('clause:parties: placeholder sign_date used in text but not declared');
    expect(reasonsOf(edited, base)[0]).toMatch(/^content_invalid:/);
  });

  it('declared but unused placeholder', () => {
    const edited = withClause('notices', { placeholders: [clause('rent').placeholders[0]] });
    expect(problems(edited)).toContain('clause:notices: placeholder monthly_rent declared but not used in text');
  });

  it('placeholder that is neither a field, a derived value nor a jurisdiction value', () => {
    const edited = withClause('notices', {
      text: 'Notice goes to {{email}}.',
      placeholders: [{ name: 'email', kind: 'name', source: 'field', from: 'email' }],
    });
    expect(problems(edited)).toContain('clause:notices: placeholder email is not a schema field');
  });

  it('placeholder with the wrong kind', () => {
    const edited = withClause('rent', {
      placeholders: [{ name: 'monthly_rent', kind: 'int', source: 'field', from: 'monthly_rent' }],
    });
    expect(problems(edited).some((p) => p.startsWith('clause:rent: placeholder monthly_rent must have'))).toBe(true);
  });

  it('stray braces', () => {
    const edited = withClause('notices', { text: 'Any notice {{ must be in writing.' });
    expect(problems(edited)).toContain('clause:notices: text has a stray {{ or }} that is not a placeholder token');
  });

  it('unknown DSL operator', () => {
    const edited = withClause('pets-none', { applies: { gt: ['term_months', 3] } as unknown as Predicate });
    expect(problems(edited)).toContain('clause:pets-none.applies: unknown predicate operator gt');
  });

  it('DSL operator naming an unknown field', () => {
    const edited = withClause('pets-none', { applies: { present: 'parking' } as unknown as Predicate });
    expect(problems(edited)).toContain('clause:pets-none.applies: present needs a field name');
  });

  it('nested DSL is validated', () => {
    const edited = withClause('pets-none', {
      applies: { all: [{ eq: ['pets', 'none'] }, { not: { bogus: 'x' } as unknown as Predicate }] },
    });
    expect(problems(edited)).toContain('clause:pets-none.applies.all[1].not: unknown predicate operator bogus');
  });

  it('mandatory clause must apply unconditionally', () => {
    const edited = withClause('rent', { applies: { present: 'monthly_rent' } });
    expect(problems(edited)).toContain('clause:rent: a mandatory clause must have applies = true');
  });

  it('duplicate order', () => {
    const edited = withClause('notices', { order: clause('parties').order });
    expect(problems(edited)).toContain('clause:notices: duplicate order 10');
  });

  it('duplicate id', () => {
    const edited: LibraryContent = { ...LIBRARY_CONTENT, clauses: [...LIBRARY_CONTENT.clauses, clause('rent')] };
    expect(problems(edited)).toContain('clause:rent: duplicate id');
  });

  it('licence and author are required', () => {
    const edited = withClause('rent', { licence: 'proprietary' as never, author: ' ' });
    const found = problems(edited);
    expect(found).toContain('clause:rent: licence must be "MIT (self-authored)"');
    expect(found).toContain('clause:rent: author is required');
  });

  it('a required frame record is missing', () => {
    const edited: LibraryContent = {
      ...LIBRARY_CONTENT,
      frame: LIBRARY_CONTENT.frame.filter((r) => r.id !== 'draft-notice'),
    };
    expect(problems(edited)).toContain('frame:draft-notice: required frame record missing');
  });

  it('method tokens must equal the closed list', () => {
    const edited = withFrame('method-tokens', { tokens: ['regex', 'llm'] });
    expect(problems(edited)).toContain('frame:method-tokens: tokens must equal the closed method token list');
  });
});
