-- Append-only audit receipts retain only ids/hashes/timestamps after matter deletion.
create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  matter_id uuid references public.matters(id) on delete set null,
  owner uuid not null,
  approver uuid not null,
  revision integer not null check (revision between 1 and 2147483646),
  bundle_digest text not null check (bundle_digest ~ '^[0-9a-f]{64}$'),
  library_hash text not null check (library_hash ~ '^[0-9a-f]{64}$'),
  approved_at timestamptz not null default now(),
  check (owner = approver)
);
alter table public.approvals enable row level security;
create policy approvals_select on public.approvals for select to authenticated using (owner = auth.uid());
revoke all on public.approvals from anon, authenticated, service_role;
grant select on public.approvals to authenticated, service_role;

create function public.guard_approval() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- Permit ONLY the referential-action detach after the actual parent has disappeared.
  if tg_op = 'UPDATE' and old.matter_id is not null and new.matter_id is null and
     (to_jsonb(new) - 'matter_id') = (to_jsonb(old) - 'matter_id') and
     not exists (select 1 from public.matters where id = old.matter_id) then return new; end if;
  raise exception 'immutable_approval' using errcode = '23514';
end $$;
revoke execute on function public.guard_approval() from public, anon, authenticated;
create trigger approval_guard before update or delete on public.approvals for each row execute function public.guard_approval();

create function public.approve_bundle(p_matter uuid, p_revision integer, p_bundle_digest text, p_library_hash text)
returns public.approvals language plpgsql security definer set search_path = '' as $$
declare v_revision integer; v_result public.approvals;
begin
  select revision into v_revision from public.matters where id = p_matter and owner = auth.uid() for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if v_revision is distinct from p_revision then raise exception 'stale_revision' using errcode = '40001'; end if;
  if not exists (select 1 from public.matter_state where matter_id=p_matter and revision=p_revision and library_hash=p_library_hash) then
    raise exception 'snapshot_missing_or_library_mismatch' using errcode='23514';
  end if;
  insert into public.approvals(matter_id,owner,approver,revision,bundle_digest,library_hash)
    values(p_matter,auth.uid(),auth.uid(),p_revision,p_bundle_digest,p_library_hash) returning * into v_result;
  return v_result;
end $$;
revoke execute on function public.approve_bundle(uuid,integer,text,text) from public, anon, authenticated;
grant execute on function public.approve_bundle(uuid,integer,text,text) to authenticated;

create function public.delete_matter(p_matter uuid) returns void language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.matters where id=p_matter and owner=auth.uid() for update;
  if not found then raise exception 'not_found' using errcode='P0002'; end if;
  -- Cascades erase messages, fields and snapshots. Approval and (in 0003) ledger links detach.
  -- Never delete call_ledger or release reservations: deletion cannot reset paid usage.
  delete from public.matters where id=p_matter;
end $$;
revoke execute on function public.delete_matter(uuid) from public, anon, authenticated;
grant execute on function public.delete_matter(uuid) to authenticated;
