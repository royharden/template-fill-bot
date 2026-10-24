// Source checks are NOT database execution/isolation proof. Deferred runtime cases are in database.integration.test.ts.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const source = (name: string): string => readFileSync(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8');
const matters = source('202610240001_matters.sql');
const approvals = source('202610240002_approvals.sql');
const usage = source('202610240003_usage.sql');
const all = [matters, approvals, usage].join('\n');
describe('authored SQL boundary declarations (static only)', () => {
  it('enables RLS on every declared table and pins search_path on every function', () => {
    for (const match of all.matchAll(/create table public\.([a-z_]+)/g)) expect(all).toContain(`alter table public.${match[1]} enable row level security`);
    const functions = [...all.matchAll(/create function public\.([a-z_]+)[\s\S]*?\$\$;/g)];
    expect(functions.length).toBeGreaterThan(8);
    for (const match of functions) { expect(match[0]).toContain("set search_path = ''"); expect(all).toContain(`revoke execute on function public.${match[1]}(`); }
  });
  it('keeps snapshot and approval writes behind owner-checked RPCs', () => {
    expect(matters).toContain('p_expected_revision'); expect(matters).toContain('revision_not_increasing');
    expect(matters).toContain('immutable_snapshot'); expect(matters).toContain('pg_column_size(state) <= 262144');
    expect(matters).not.toMatch(/grant\s+(?:insert|update|delete)[^;]+public\.matter_state/i);
    expect(approvals).toContain('owner = auth.uid() for update'); expect(approvals).toContain('snapshot_missing_or_library_mismatch');
    expect(approvals).toContain("(to_jsonb(new) - 'matter_id') = (to_jsonb(old) - 'matter_id')");
    expect(approvals).not.toMatch(/grant\s+(?:insert|update|delete)[^;]+public\.approvals/i);
  });
  it('keeps atomic admission and conservative settlement service-only', () => {
    expect(usage).toContain('pg_advisory_xact_lock'); expect(usage).toContain("'dispatch',false"); expect(usage).toContain("'dispatch',true");
    expect(usage).toContain('v_install.reserved_usd+v_install.settled_usd+v_bound');
    expect(usage).toContain("p_status in ('dispatched','unknown_after_dispatch')");
    expect(usage).toContain('grant execute on function public.reserve_attempt(uuid,uuid,text,numeric,jsonb) to service_role');
    expect(usage).not.toMatch(/grant execute on function public\.(?:reserve_attempt|settle_attempt)[^;]+to authenticated/i);
    expect(approvals).not.toMatch(/delete from public\.call_ledger/i);
  });
});
