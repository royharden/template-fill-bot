// Browser facade over the canonical pure core in supabase/functions/_shared/ (PLAN K1, section 3.3).
// Browser code imports the core ONLY through this file. It re-exports the pure fillkit core and the locked
// content; never providers/ or callledger/ (M6). The DOCX writer and gate are added here in M4.
export * from '../../supabase/functions/_shared/fillkit/index.ts';
export * from '../../supabase/functions/_shared/content/types.ts';
export { CLAUSES } from '../../supabase/functions/_shared/content/clauses.ts';
export { FRAME } from '../../supabase/functions/_shared/content/frame.ts';
export { JURISDICTION } from '../../supabase/functions/_shared/content/jurisdiction.ts';
export { LIBRARY_LOCK } from '../../supabase/functions/_shared/content/library.lock.ts';
