-- AUTHORED ONLY: not applied or validated against a database (DV-DB / DV-RLS).
-- UTF-16 code units, matching JavaScript .length (astral code points count as two).
create function public.utf16_length(p_text text) returns integer
language sql immutable strict parallel safe set search_path = '' as $$
  select coalesce(sum(case when ascii(c) > 65535 then 2 else 1 end), 0)::integer
  from regexp_split_to_table(p_text, '') as t(c)
$$;
revoke execute on function public.utf16_length(text) from public, anon;
grant execute on function public.utf16_length(text) to authenticated, service_role;

create table public.matters (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null default 'Untitled matter' check (char_length(title) between 1 and 120),
  mode text not null default 'dry_run' check (mode in ('dry_run','live')),
  revision integer not null default 1 check (revision between 1 and 2147483646),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.messages (
  matter_id uuid not null references public.matters(id) on delete cascade,
  id text not null check (id ~ '^[A-Za-z0-9_-]{1,32}$'),
  ord smallint not null check (ord between 1 and 12),
  text_normalised text not null check (public.utf16_length(text_normalised) between 1 and 8000),
  primary key (matter_id, id), unique (matter_id, ord)
);
create table public.fields (
  matter_id uuid not null references public.matters(id) on delete cascade,
  field_key text not null check (field_key in ('landlord','tenants','address','start_date','term_months','end_date','monthly_rent','rent_due_day','deposit','pets','smoking','furnished','utilities','guarantor','break_month')),
  state text not null check (state in ('valid','missing','conflict','ambiguous','invalid','none_confirmed')),
  value jsonb, method text check (method in ('regex','llm','jev','mock','user_answer','none_confirmed','computed')),
  pointer text check (pointer is null or (char_length(pointer) <= 96 and pointer ~ '^msg:[A-Za-z0-9_-]{1,32}:[0-9]+-[0-9]+$')),
  question_id text check (question_id is null or char_length(question_id) <= 200),
  answer jsonb check (answer is null or pg_column_size(answer) <= 16384),
  updated_at timestamptz not null default now(),
  primary key (matter_id, field_key),
  check (value is null or pg_column_size(value) <= 16384)
);
create table public.matter_state (
  matter_id uuid not null references public.matters(id) on delete cascade,
  revision integer not null check (revision between 1 and 2147483646),
  state jsonb not null check (jsonb_typeof(state) = 'object' and pg_column_size(state) <= 262144),
  state_hash text not null check (state_hash ~ '^[0-9a-f]{64}$'),
  library_hash text not null check (library_hash ~ '^[0-9a-f]{64}$'),
  jurisdiction_hash text not null check (jurisdiction_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  primary key (matter_id, revision)
);

alter table public.matters enable row level security;
alter table public.messages enable row level security;
alter table public.fields enable row level security;
alter table public.matter_state enable row level security;
create policy matters_select on public.matters for select to authenticated using (owner = auth.uid());
create policy matters_insert on public.matters for insert to authenticated with check (owner = auth.uid() and revision = 1);
create policy matters_update on public.matters for update to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
create policy messages_select on public.messages for select to authenticated using (exists (select 1 from public.matters m where m.id = matter_id and m.owner = auth.uid()));
create policy messages_write on public.messages for all to authenticated using (exists (select 1 from public.matters m where m.id = matter_id and m.owner = auth.uid())) with check (exists (select 1 from public.matters m where m.id = matter_id and m.owner = auth.uid()));
create policy fields_select on public.fields for select to authenticated using (exists (select 1 from public.matters m where m.id = matter_id and m.owner = auth.uid()));
create policy fields_write on public.fields for all to authenticated using (exists (select 1 from public.matters m where m.id = matter_id and m.owner = auth.uid())) with check (exists (select 1 from public.matters m where m.id = matter_id and m.owner = auth.uid()));
create policy state_select on public.matter_state for select to authenticated using (exists (select 1 from public.matters m where m.id = matter_id and m.owner = auth.uid()));
-- No direct state insert/update/delete: save_matter_state owns the atomic write, avoiding a forged
-- snapshot/intake divergence. The owner can append through that authenticated-only RPC.
revoke all on public.matters, public.messages, public.fields, public.matter_state from anon, authenticated;
grant select on public.matters, public.messages, public.fields, public.matter_state to authenticated;
grant insert (id, owner, title, mode) on public.matters to authenticated;
grant update (title, mode) on public.matters to authenticated;
grant insert, update, delete on public.messages, public.fields to authenticated;
grant select on public.matters, public.messages, public.fields, public.matter_state to service_role;

create function public.guard_matter() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.owner is distinct from old.owner or new.id is distinct from old.id or new.created_at is distinct from old.created_at then
    raise exception 'immutable_matter_identity' using errcode = '23514';
  end if;
  -- Column grants prevent authenticated callers from supplying a revision.
  -- A title/mode/config edit still invalidates approval by increasing the revision.
  if new.title is distinct from old.title or new.mode is distinct from old.mode then new.revision := old.revision + 1; end if;
  new.updated_at := clock_timestamp();
  return new;
end $$;
revoke execute on function public.guard_matter() from public, anon, authenticated;
create trigger matter_guard before update on public.matters for each row execute function public.guard_matter();

create function public.bump_parent_revision() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_matter uuid;
begin
  if tg_op = 'UPDATE' and new.matter_id is distinct from old.matter_id then raise exception 'immutable_parent' using errcode = '23514'; end if;
  if tg_op = 'DELETE' then v_matter := old.matter_id; else v_matter := new.matter_id; end if;
  -- Serialize ALL writes under the parent lock, including aggregate intake checks below.
  update public.matters set revision = revision + 1 where id = v_matter;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
revoke execute on function public.bump_parent_revision() from public, anon, authenticated;
create trigger messages_revision before insert or update or delete on public.messages for each row execute function public.bump_parent_revision();
create trigger fields_revision before insert or update or delete on public.fields for each row execute function public.bump_parent_revision();

create function public.check_intake_bounds() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_matter uuid; v_count bigint; v_size bigint;
begin
  if tg_op = 'DELETE' then v_matter := old.matter_id; else v_matter := new.matter_id; end if;
  perform 1 from public.matters where id = v_matter for update;
  select count(*), coalesce(sum(public.utf16_length(text_normalised)),0) into v_count,v_size from public.messages where matter_id = v_matter;
  if v_count > 12 or v_size > 8000 then raise exception 'intake_limit' using errcode = '23514'; end if;
  return null;
end $$;
revoke execute on function public.check_intake_bounds() from public, anon, authenticated;
create constraint trigger messages_bounds after insert or update or delete on public.messages deferrable initially immediate for each row execute function public.check_intake_bounds();

create function public.guard_snapshot() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_current integer;
begin
  if tg_op = 'DELETE' and not exists (select 1 from public.matters where id = old.matter_id) then return old; end if;
  if tg_op <> 'INSERT' then raise exception 'immutable_snapshot' using errcode = '23514'; end if;
  select revision into v_current from public.matters where id = new.matter_id for update;
  if new.revision is distinct from v_current or (new.state->>'revision')::integer is distinct from new.revision then raise exception 'snapshot_revision_mismatch' using errcode = '23514'; end if;
  return new;
end $$;
revoke execute on function public.guard_snapshot() from public, anon, authenticated;
create trigger snapshot_guard before insert or update or delete on public.matter_state for each row execute function public.guard_snapshot();

-- Atomic current projection + immutable canonical snapshot. Only this RPC inserts snapshots.
-- First save: expected=current=state.revision=1. Subsequent saves: expected=current and
-- state.revision > current (several locally answered questions may be saved together).
create function public.save_matter_state(p_matter uuid, p_expected_revision integer, p_state jsonb,
  p_state_hash text, p_library_hash text, p_jurisdiction_hash text) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_current integer; v_revision integer; v_item jsonb; v_key text; v_ord integer := 0; v_total integer := 0; v_seen text[] := '{}';
begin
  select revision into v_current from public.matters where id = p_matter and owner = auth.uid() for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if v_current is distinct from p_expected_revision then raise exception 'stale_revision' using errcode = '40001'; end if;
  if p_state is null or jsonb_typeof(p_state) <> 'object' or pg_column_size(p_state) > 262144 or
     (p_state->>'schema_version') is distinct from '1' or jsonb_typeof(p_state->'intake') is distinct from 'array' or
     jsonb_typeof(p_state->'fields') is distinct from 'object' or
     coalesce(p_state->>'extractor_method','') not in ('regex','mock','llm','jev') then raise exception 'invalid_state' using errcode = '23514'; end if;
  v_revision := (p_state->>'revision')::integer;
  if v_revision is null or v_revision < 1 or v_revision < v_current or
     (v_revision = v_current and exists (select 1 from public.matter_state where matter_id=p_matter)) then
    raise exception 'revision_not_increasing' using errcode = '23514';
  end if;
  if jsonb_array_length(p_state->'intake') not between 1 and 12 then raise exception 'intake_limit' using errcode = '23514'; end if;
  -- Validate the complete intake before mutating anything. Projection constraints check again.
  for v_item in select value from jsonb_array_elements(p_state->'intake') loop
    if jsonb_typeof(v_item) <> 'object' or jsonb_typeof(v_item->'id') is distinct from 'string' or
       jsonb_typeof(v_item->'text_normalised') is distinct from 'string' or (v_item->>'id') !~ '^[A-Za-z0-9_-]{1,32}$' or
       (v_item->>'id') = any(v_seen) or public.utf16_length(v_item->>'text_normalised') not between 1 and 8000 then
      raise exception 'invalid_intake' using errcode = '23514';
    end if;
    v_seen := array_append(v_seen,v_item->>'id');
    v_total := v_total + public.utf16_length(v_item->>'text_normalised');
  end loop;
  if v_total > 8000 then raise exception 'intake_limit' using errcode = '23514'; end if;
  if (select count(*) from jsonb_object_keys(p_state->'fields')) <> 15 then raise exception 'invalid_fields' using errcode='23514'; end if;
  delete from public.messages where matter_id = p_matter;
  delete from public.fields where matter_id = p_matter;
  for v_item in select value from jsonb_array_elements(p_state->'intake') loop
    v_ord := v_ord + 1;
    insert into public.messages(matter_id,id,ord,text_normalised) values(p_matter,v_item->>'id',v_ord,v_item->>'text_normalised');
  end loop;
  for v_key,v_item in select key,value from jsonb_each(p_state->'fields') loop
    if jsonb_typeof(v_item) <> 'object' or (v_item->>'field') is distinct from v_key then raise exception 'invalid_field' using errcode='23514'; end if;
    insert into public.fields(matter_id,field_key,state,value,method,pointer,answer)
      values(p_matter,v_key,v_item->>'state',v_item->'value',v_item->>'method',v_item->>'pointer',v_item->'answer');
  end loop;
  -- Per-row projection triggers invalidate direct edits. Restore the caller's validated logical revision
  -- within this same locked transaction before inserting the corresponding immutable snapshot.
  update public.matters set revision = v_revision where id = p_matter;
  insert into public.matter_state(matter_id,revision,state,state_hash,library_hash,jurisdiction_hash)
    values(p_matter,v_revision,p_state,p_state_hash,p_library_hash,p_jurisdiction_hash);
  return v_revision;
end $$;
revoke execute on function public.save_matter_state(uuid,integer,jsonb,text,text,text) from public, anon, authenticated;
grant execute on function public.save_matter_state(uuid,integer,jsonb,text,text,text) to authenticated;
