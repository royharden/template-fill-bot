-- Service-only atomic admission and conservative settlement. AUTHORED, NOT RUN.
create table public.quota_windows (
  owner uuid not null, kind text not null check (kind in ('minute','day')), window_start timestamptz not null,
  calls integer not null default 0 check (calls >= 0),
  reserved_usd numeric(20,9) not null default 0 check (reserved_usd >= 0 and reserved_usd <> 'NaN'::numeric),
  settled_usd numeric(20,9) not null default 0 check (settled_usd >= 0 and settled_usd <> 'NaN'::numeric),
  primary key(owner,kind,window_start)
);
create table public.quota_install (
  day date primary key,
  reserved_usd numeric(20,9) not null default 0 check (reserved_usd >= 0 and reserved_usd <> 'NaN'::numeric),
  settled_usd numeric(20,9) not null default 0 check (settled_usd >= 0 and settled_usd <> 'NaN'::numeric)
);
create table public.call_reservations (
  request_id uuid primary key, owner uuid not null, input_hash text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  reserved_usd numeric(20,9) not null check (reserved_usd >= 0 and reserved_usd <> 'NaN'::numeric),
  settled_usd numeric(20,9) check (settled_usd >= 0 and settled_usd <> 'NaN'::numeric),
  status text not null default 'reserved' check (status in ('reserved','dispatched','settled','failed_before_dispatch','unknown_after_dispatch')),
  minute_start timestamptz not null, day_start timestamptz not null, install_day date not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.call_ledger (
  call_id uuid primary key, run_id uuid not null, request_id uuid not null unique references public.call_reservations(request_id),
  owner uuid not null, matter_id uuid references public.matters(id) on delete set null,
  provider text not null check (provider in ('anthropic','openai_compatible','typesafe','mock')),
  model text not null check (model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'),
  prompt_hash text not null check (prompt_hash ~ '^[0-9a-f]{64}$'),
  input_tokens bigint check (input_tokens between 0 and 9007199254740991),
  output_tokens bigint check (output_tokens between 0 and 9007199254740991),
  reserved_usd numeric(20,9) not null check (reserved_usd >= 0 and reserved_usd <> 'NaN'::numeric),
  settled_usd numeric(20,9) check (settled_usd >= 0 and settled_usd <> 'NaN'::numeric),
  price_table_date date not null, latency_ms integer not null check (latency_ms >= 0),
  status text not null check (status in ('reserved','dispatched','settled','failed_before_dispatch','unknown_after_dispatch')),
  raw_usage jsonb not null default '{}'::jsonb check (jsonb_typeof(raw_usage)='object' and pg_column_size(raw_usage) <= 4096),
  created_at timestamptz not null default now()
);
alter table public.quota_windows enable row level security;
alter table public.quota_install enable row level security;
alter table public.call_reservations enable row level security;
alter table public.call_ledger enable row level security;
create policy ledger_select on public.call_ledger for select to authenticated using (owner=auth.uid());
-- All quota tables intentionally have NO browser policies/grants; service_role bypasses RLS.
revoke all on public.quota_windows,public.quota_install,public.call_reservations,public.call_ledger from anon,authenticated,service_role;
grant select on public.call_ledger to authenticated;
grant select on public.quota_windows,public.quota_install,public.call_reservations,public.call_ledger to service_role;
grant insert on public.call_ledger to service_role;

create function public.guard_ledger() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_res public.call_reservations; v_pair record;
begin
  if tg_op='UPDATE' and old.matter_id is not null and new.matter_id is null and
     (to_jsonb(new)-'matter_id')=(to_jsonb(old)-'matter_id') and not exists(select 1 from public.matters where id=old.matter_id) then return new; end if;
  if tg_op <> 'INSERT' then raise exception 'immutable_ledger' using errcode='23514'; end if;
  select * into v_res from public.call_reservations where request_id=new.request_id;
  if not found or v_res.owner is distinct from new.owner or v_res.reserved_usd is distinct from new.reserved_usd or
     v_res.status is distinct from new.status or v_res.settled_usd is distinct from new.settled_usd then raise exception 'reservation_mismatch' using errcode='23514'; end if;
  if new.matter_id is not null and not exists(select 1 from public.matters where id=new.matter_id and owner=new.owner) then raise exception 'not_found' using errcode='23514'; end if;
  for v_pair in select key,value from jsonb_each(new.raw_usage) loop
    if v_pair.key not in ('input_tokens','output_tokens','prompt_tokens','completion_tokens','total_tokens','cache_creation_input_tokens','cache_read_input_tokens') or
       jsonb_typeof(v_pair.value)<>'number' or (v_pair.value::text) !~ '^[0-9]+$' or (v_pair.value::text)::numeric > 9007199254740991 then
      raise exception 'unsafe_raw_usage' using errcode='23514';
    end if;
  end loop;
  return new;
end $$;
revoke execute on function public.guard_ledger() from public,anon,authenticated;
create trigger ledger_guard before insert or update or delete on public.call_ledger for each row execute function public.guard_ledger();

create function public.reserve_attempt(p_owner uuid,p_request_id uuid,p_input_hash text,p_max_cost_usd numeric,p_caps jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_res public.call_reservations; v_install public.quota_install; v_dayrow public.quota_windows; v_minrow public.quota_windows;
  v_day date := (now() at time zone 'UTC')::date; v_day_start timestamptz; v_minute timestamptz := date_trunc('minute',now());
  v_rate integer; v_max numeric; v_user numeric; v_global numeric; v_bound numeric;
begin
  if p_owner is null or p_request_id is null or p_input_hash is null or p_input_hash !~ '^[0-9a-f]{64}$' or
     p_max_cost_usd is null or p_max_cost_usd <= 0 or p_max_cost_usd > 1000000 or p_max_cost_usd='NaN'::numeric then raise exception 'invalid_reservation' using errcode='23514'; end if;
  -- Locks even the not-yet-existing request row. A reused id can NEVER produce another dispatch=true.
  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,0));
  select * into v_res from public.call_reservations where request_id=p_request_id for update;
  if found then
    if v_res.owner is distinct from p_owner or v_res.input_hash is distinct from p_input_hash then return jsonb_build_object('status','conflict','dispatch',false); end if;
    return jsonb_build_object('status',v_res.status,'dispatch',false,'reserved_usd',v_res.reserved_usd,'settled_usd',v_res.settled_usd);
  end if;
  if p_caps is null or jsonb_typeof(p_caps)<>'object' or (select count(*) from jsonb_object_keys(p_caps))<>4 then raise exception 'invalid_caps' using errcode='23514'; end if;
  v_rate := (p_caps->>'rate_per_min_user')::integer; v_max := (p_caps->>'max_attempt_usd')::numeric;
  v_user := (p_caps->>'daily_user_usd')::numeric; v_global := (p_caps->>'daily_install_usd')::numeric;
  if v_rate is null or v_rate not between 1 and 10000 or v_max is null or v_user is null or v_global is null or
     v_max <= 0 or v_user <= 0 or v_global <= 0 or v_max > 1000000 or v_user > 1000000 or v_global > 1000000 or
     v_max='NaN'::numeric or v_user='NaN'::numeric or v_global='NaN'::numeric then raise exception 'invalid_caps' using errcode='23514'; end if;
  -- Round conservatively to the table precision BEFORE checking caps.
  v_bound := ceil(p_max_cost_usd*1000000000)/1000000000;
  if v_bound > v_max then return jsonb_build_object('status','quota_exceeded','dispatch',false); end if;
  v_day_start := v_day::timestamp at time zone 'UTC';
  -- Fixed lock order everywhere: request -> install day -> owner day -> owner minute.
  insert into public.quota_install(day) values(v_day) on conflict do nothing;
  select * into v_install from public.quota_install where day=v_day for update;
  insert into public.quota_windows(owner,kind,window_start) values(p_owner,'day',v_day_start),(p_owner,'minute',v_minute) on conflict do nothing;
  select * into v_dayrow from public.quota_windows where owner=p_owner and kind='day' and window_start=v_day_start for update;
  select * into v_minrow from public.quota_windows where owner=p_owner and kind='minute' and window_start=v_minute for update;
  if v_minrow.calls >= v_rate or v_dayrow.reserved_usd+v_dayrow.settled_usd+v_bound > v_user or
     v_install.reserved_usd+v_install.settled_usd+v_bound > v_global then return jsonb_build_object('status','quota_exceeded','dispatch',false); end if;
  update public.quota_install set reserved_usd=reserved_usd+v_bound where day=v_day;
  update public.quota_windows set calls=calls+1,reserved_usd=reserved_usd+v_bound where owner=p_owner and
    ((kind='day' and window_start=v_day_start) or (kind='minute' and window_start=v_minute));
  insert into public.call_reservations(request_id,owner,input_hash,reserved_usd,minute_start,day_start,install_day)
    values(p_request_id,p_owner,p_input_hash,v_bound,v_minute,v_day_start,v_day);
  return jsonb_build_object('status','reserved','dispatch',true,'reserved_usd',v_bound,'settled_usd',null);
end $$;
revoke execute on function public.reserve_attempt(uuid,uuid,text,numeric,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.reserve_attempt(uuid,uuid,text,numeric,jsonb) to service_role;

create function public.settle_attempt(p_request_id uuid,p_actual_usd numeric,p_status text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_res public.call_reservations; v_actual numeric;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,0));
  select * into v_res from public.call_reservations where request_id=p_request_id for update;
  if not found then raise exception 'reservation_missing' using errcode='P0002'; end if;
  if p_status is null or p_status not in ('dispatched','settled','failed_before_dispatch','unknown_after_dispatch') then raise exception 'invalid_status' using errcode='23514'; end if;
  if p_actual_usd is not null and (p_actual_usd<0 or p_actual_usd>1000000 or p_actual_usd='NaN'::numeric) then raise exception 'invalid_actual' using errcode='23514'; end if;
  if (p_status in ('dispatched','unknown_after_dispatch') and p_actual_usd is not null) or
     (p_status='settled' and p_actual_usd is null) or
     (p_status='failed_before_dispatch' and p_actual_usd is distinct from 0::numeric) then raise exception 'invalid_settlement' using errcode='23514'; end if;
  if v_res.status in ('settled','failed_before_dispatch') then
    if v_res.status=p_status and v_res.settled_usd=ceil(p_actual_usd*1000000000)/1000000000 then
      return jsonb_build_object('status',v_res.status,'reserved_usd',v_res.reserved_usd,'settled_usd',v_res.settled_usd);
    end if;
    raise exception 'settlement_conflict' using errcode='23514';
  end if;
  if p_status='failed_before_dispatch' and v_res.status<>'reserved' then raise exception 'already_dispatched' using errcode='23514'; end if;
  if p_status='dispatched' and v_res.status not in ('reserved','dispatched') then raise exception 'invalid_transition' using errcode='23514'; end if;
  if p_status in ('dispatched','unknown_after_dispatch') then
    -- NO refund, even after a timeout or process crash; daily reserved spend stays charged.
    update public.call_reservations set status=p_status,updated_at=clock_timestamp() where request_id=p_request_id;
    return jsonb_build_object('status',p_status,'reserved_usd',v_res.reserved_usd,'settled_usd',null);
  end if;
  v_actual := ceil(p_actual_usd*1000000000)/1000000000;
  perform 1 from public.quota_install where day=v_res.install_day for update;
  perform 1 from public.quota_windows where owner=v_res.owner and kind='day' and window_start=v_res.day_start for update;
  perform 1 from public.quota_windows where owner=v_res.owner and kind='minute' and window_start=v_res.minute_start for update;
  update public.quota_install set reserved_usd=reserved_usd-v_res.reserved_usd,settled_usd=settled_usd+v_actual where day=v_res.install_day;
  update public.quota_windows set reserved_usd=reserved_usd-v_res.reserved_usd,settled_usd=settled_usd+v_actual where owner=v_res.owner and
    ((kind='day' and window_start=v_res.day_start) or (kind='minute' and window_start=v_res.minute_start));
  update public.call_reservations set status=p_status,settled_usd=v_actual,updated_at=clock_timestamp() where request_id=p_request_id;
  return jsonb_build_object('status',p_status,'reserved_usd',v_res.reserved_usd,'settled_usd',v_actual);
end $$;
revoke execute on function public.settle_attempt(uuid,numeric,text) from public,anon,authenticated,service_role;
grant execute on function public.settle_attempt(uuid,numeric,text) to service_role;
