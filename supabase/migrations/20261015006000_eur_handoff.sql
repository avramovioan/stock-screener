-- P6: "Trade on IBKR" hand-off data (spec 5.7, 6.3, 6.9, 13.3).
--   ibkr_catalogue                weekly import of the public IBIS and AEB product lists (A-19); display data, readable by anon
--   eur_equivalents               the resolved EUR line per canonical security and exchange; display data, readable by anon
--   eur_equivalent_overrides      operator decisions (force / block), audited; service role only
--   profiles.default_destination  the owner's preferred iBot destination (A-39); already created by P1, re-asserted here
--   app.replace_eur_equivalents / app.eur_resolve_targets   service-role helpers used by worker-tick
-- The EUR mapping is never read by screening: nothing in eligibility, ranking, thresholds or episodes references these tables.

do $$
begin
  if to_regclass('public.securities') is null or to_regclass('public.profiles') is null
     or to_regclass('public.audit_events') is null or to_regclass('public.app_settings') is null
     or to_regclass('public.fx_rates') is null or to_regclass('public.todays_discounts') is null then
    raise exception 'P6 needs public.securities, profiles, audit_events, app_settings, fx_rates and todays_discounts from P1';
  end if;
end $$;

-- 1. enum -------------------------------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public' and t.typname = 'eur_status') then
    create type public.eur_status as enum ('verified', 'unverified', 'none');
  end if;
end $$;

-- 2. ibkr_catalogue ---------------------------------------------------------------------------------------
create table if not exists public.ibkr_catalogue (
  exchange_id  text not null,
  conid        bigint not null,
  symbol       text not null,
  local_symbol text not null,
  isin         text,
  currency     text not null,
  description  text,
  product_type text not null,
  fetched_at   timestamptz not null default now(),
  primary key (exchange_id, conid)
);

-- spec 6.3 named two columns `type` and `imported_at`; keep one set of names whichever migration created the table first
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ibkr_catalogue' and column_name = 'type') then
    alter table public.ibkr_catalogue rename column type to product_type;
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ibkr_catalogue' and column_name = 'imported_at') then
    alter table public.ibkr_catalogue rename column imported_at to fetched_at;
  end if;
end $$;

create index if not exists ibkr_catalogue_isin_idx on public.ibkr_catalogue (isin);
create index if not exists ibkr_catalogue_local_symbol_idx on public.ibkr_catalogue (local_symbol);
create index if not exists ibkr_catalogue_symbol_idx on public.ibkr_catalogue (symbol);

-- 3. eur_equivalents --------------------------------------------------------------------------------------
create table if not exists public.eur_equivalents (
  id                uuid primary key default gen_random_uuid(),
  security_id       uuid not null references public.securities (id) on delete cascade,   -- the CANONICAL security it relates to
  ibkr_exchange_id  text not null check (ibkr_exchange_id in ('IBIS', 'AEB')),
  ibkr_conid        bigint,
  ibkr_local_symbol text,
  isin              text,
  eur_symbol_yahoo  text,
  currency          char(3) not null default 'EUR',
  status            public.eur_status not null,
  verification      jsonb not null default '{}'::jsonb,   -- checks, similarity, price deviation, fx rate_date (5.7 step 5)
  verified_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (security_id, ibkr_exchange_id)
);
alter table public.eur_equivalents add column if not exists created_at timestamptz not null default now();
alter table public.eur_equivalents add column if not exists updated_at timestamptz not null default now();

-- A-28 at the database level: `verified` needs the contract, the Yahoo line and a verification time; `none` carries no contract at all.
alter table public.eur_equivalents drop constraint if exists eur_equivalents_status_shape;
alter table public.eur_equivalents add constraint eur_equivalents_status_shape check (
  currency = 'EUR' and (
    (status = 'none' and ibkr_conid is null and ibkr_local_symbol is null and eur_symbol_yahoo is null and verified_at is null)
    or (status = 'unverified' and ibkr_conid is not null and ibkr_local_symbol is not null and verified_at is null)
    or (status = 'verified' and ibkr_conid is not null and ibkr_local_symbol is not null and eur_symbol_yahoo is not null and verified_at is not null)
  )
);

drop trigger if exists eur_equivalents_touch on public.eur_equivalents;
create trigger eur_equivalents_touch before update on public.eur_equivalents
  for each row execute function app.touch_updated_at();

-- P1 left todays_discounts.eur_equivalent_id without a foreign key ("arrives with P2"); nothing writes it, the cards join by security
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'todays_discounts_eur_equivalent_fk') then
    alter table public.todays_discounts add constraint todays_discounts_eur_equivalent_fk
      foreign key (eur_equivalent_id) references public.eur_equivalents (id) on delete set null;
  end if;
end $$;

-- 4. eur_equivalent_overrides (operator decisions, audited) -----------------------------------------------
create table if not exists public.eur_equivalent_overrides (
  id                uuid primary key default gen_random_uuid(),
  security_id       uuid not null references public.securities (id) on delete cascade,
  ibkr_exchange_id  text not null check (ibkr_exchange_id in ('IBIS', 'AEB')),
  action            text not null check (action in ('force', 'block')),   -- force: use this line as verified; block: no EUR line on this exchange
  ibkr_conid        bigint,
  ibkr_local_symbol text,
  eur_symbol_yahoo  text,
  isin              text,
  reason            text not null check (length(btrim(reason)) >= 10),
  active            boolean not null default true,
  created_by        uuid references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (action = 'block' or (ibkr_conid is not null and ibkr_local_symbol is not null and eur_symbol_yahoo is not null))
);
create unique index if not exists eur_overrides_one_active
  on public.eur_equivalent_overrides (security_id, ibkr_exchange_id) where active;

drop trigger if exists eur_overrides_touch on public.eur_equivalent_overrides;
create trigger eur_overrides_touch before update on public.eur_equivalent_overrides
  for each row execute function app.touch_updated_at();

-- Every change is written to audit_events. P1's table has (actor_id, action, target_type, target_id, details); spec 6.3 names the columns
-- (actor, actor_user_id, event_type, target_type, target_id, data). The trigger function is generated for whichever shape exists.
do $outer$
declare
  v_cols text;
  v_vals text;
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'audit_events' and column_name = 'event_type') then
    v_cols := 'actor, actor_user_id, event_type, target_type, target_id, data';
    v_vals := $v$case when auth.uid() is null then 'service' else 'admin' end, auth.uid(), 'eur_override.' || lower(tg_op), 'security', r.security_id::text, v_data$v$;
  elsif exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'audit_events' and column_name = 'action') then
    v_cols := 'actor_id, action, target_type, target_id, details';
    v_vals := $v$auth.uid(), 'eur_override.' || lower(tg_op), 'security', r.security_id::text, v_data$v$;
  else
    raise exception 'public.audit_events has neither event_type nor action: adapt app.audit_eur_override by hand';
  end if;
  execute format($f$
    create or replace function app.audit_eur_override() returns trigger
    language plpgsql security definer set search_path = '' as $fn$
    declare
      r public.eur_equivalent_overrides;
      v_data jsonb;
    begin
      r := case when tg_op = 'DELETE' then old else new end;
      v_data := jsonb_build_object('override_id', r.id, 'exchange', r.ibkr_exchange_id, 'action', r.action, 'active', r.active, 'reason', r.reason);
      insert into public.audit_events (%s) values (%s);
      return r;
    end $fn$ $f$, v_cols, v_vals);
end $outer$;

drop trigger if exists eur_overrides_audit on public.eur_equivalent_overrides;
create trigger eur_overrides_audit after insert or update or delete on public.eur_equivalent_overrides
  for each row execute function app.audit_eur_override();

-- 5. RLS: display data is public (nothing user specific), writes are service role only ---------------------
alter table public.ibkr_catalogue enable row level security;
alter table public.eur_equivalents enable row level security;
alter table public.eur_equivalent_overrides enable row level security;

revoke all on public.ibkr_catalogue, public.eur_equivalents, public.eur_equivalent_overrides from anon, authenticated;
grant select on public.ibkr_catalogue, public.eur_equivalents to anon, authenticated;

drop policy if exists ibkr_catalogue_public_read on public.ibkr_catalogue;
create policy ibkr_catalogue_public_read on public.ibkr_catalogue for select to anon, authenticated using (true);
drop policy if exists eur_equivalents_public_read on public.eur_equivalents;
create policy eur_equivalents_public_read on public.eur_equivalents for select to anon, authenticated using (true);
-- eur_equivalent_overrides: RLS on, no grant and no policy for anon or authenticated; the service role (which bypasses RLS) is the only user

-- 6. profiles.default_destination (A-39): P1 created it; make sure the constraint and the column grants exist ----
alter table public.profiles add column if not exists default_destination text not null default 'IBIS2';
alter table public.profiles drop constraint if exists profiles_default_destination_check;
alter table public.profiles add constraint profiles_default_destination_check check (default_destination in ('IBIS2', 'IBIS', 'AEB'));
grant select (default_destination) on public.profiles to authenticated;
grant update (default_destination) on public.profiles to authenticated;

-- 7. settings ---------------------------------------------------------------------------------------------
insert into public.app_settings (key, value, description, is_public) values
  ('eur_catalogue', '{"enabled": true, "require_shares": false, "max_resolve_per_run": 40, "extra_symbols": []}'::jsonb,
   'Weekly IBKR catalogue import and EUR-equivalent resolution (spec 5.7). enabled=false stops the import; require_shares=true makes a missing sharesOutstanding block verification.', false),
  ('eur_catalogue_state', '{}'::jsonb, 'Bookkeeping of the weekly catalogue import, written by worker-tick', false)
on conflict (key) do nothing;

-- 8. service-role helpers -----------------------------------------------------------------------------------
-- One transaction: upsert the given rows, then delete the security's rows for exchanges that are no longer in the set.
create or replace function app.replace_eur_equivalents(p_security_id uuid, p_rows jsonb) returns int
language plpgsql security definer set search_path = public, app as $$
declare
  v_n int;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'p_rows must be a non-empty json array' using errcode = '22023';
  end if;
  insert into eur_equivalents (security_id, ibkr_exchange_id, ibkr_conid, ibkr_local_symbol, isin, eur_symbol_yahoo, status, verification, verified_at)
  select p_security_id, r.ibkr_exchange_id, r.ibkr_conid, r.ibkr_local_symbol, r.isin, r.eur_symbol_yahoo,
         r.status::eur_status, coalesce(r.verification, '{}'::jsonb), r.verified_at
    from jsonb_to_recordset(p_rows) as r(ibkr_exchange_id text, ibkr_conid bigint, ibkr_local_symbol text, isin text, eur_symbol_yahoo text,
                                         status text, verification jsonb, verified_at timestamptz)
  on conflict (security_id, ibkr_exchange_id) do update set
    ibkr_conid = excluded.ibkr_conid, ibkr_local_symbol = excluded.ibkr_local_symbol, isin = excluded.isin,
    eur_symbol_yahoo = excluded.eur_symbol_yahoo, status = excluded.status, verification = excluded.verification,
    verified_at = excluded.verified_at;
  get diagnostics v_n = row_count;
  delete from eur_equivalents
   where security_id = p_security_id
     and ibkr_exchange_id not in (select r.ibkr_exchange_id from jsonb_to_recordset(p_rows) as r(ibkr_exchange_id text));
  return v_n;
end $$;

-- Canonical securities that need (re)resolution: today's cards, the operator watch list (app_settings eur_catalogue.extra_symbols, Yahoo symbols)
-- and, when P5 data exists, the canonical securities of held companies.
-- Due when never resolved; older than 30 days; doubtful (unverified or none) and older than the latest catalogue import;
-- or an override changed after the last resolution.
create or replace function app.eur_resolve_targets(p_run uuid, p_limit int default 40) returns setof uuid
language plpgsql stable security definer set search_path = public, app as $$
declare
  v_held text := '';
begin
  if to_regclass('public.broker_positions') is not null then
    v_held := $h$ union
      select p.signal_security_id from broker_positions p where p.signal_security_id is not null $h$;
  end if;
  return query execute format($q$
    with watchlist as (
      select case when jsonb_typeof(a.v) = 'array' then a.v else '[]'::jsonb end as symbols
        from (select (select value -> 'extra_symbols' from app_settings where key = 'eur_catalogue') as v) a
    ),
    cand as (
      select t.security_id as id from todays_discounts t where t.scan_run_id = $1
      union
      select s.id from securities s where s.is_canonical and s.yahoo_symbol in (select jsonb_array_elements_text(symbols) from watchlist)
      %s
    )
    select c.id from cand c
     where not exists (select 1 from eur_equivalents e where e.security_id = c.id)
        or exists (select 1 from eur_equivalents e where e.security_id = c.id and e.updated_at < now() - interval '30 days')
        or exists (select 1 from eur_equivalents e where e.security_id = c.id and e.status <> 'verified'
                     and e.updated_at < coalesce((select max(k.fetched_at) from ibkr_catalogue k), '-infinity'::timestamptz))
        or exists (select 1 from eur_equivalent_overrides o where o.security_id = c.id
                     and o.updated_at > coalesce((select max(e.updated_at) from eur_equivalents e where e.security_id = c.id), '-infinity'::timestamptz))
     order by c.id
     limit $2 $q$, v_held) using p_run, p_limit;
end $$;

revoke all on function app.replace_eur_equivalents(uuid, jsonb) from public, anon, authenticated;
revoke all on function app.eur_resolve_targets(uuid, int) from public, anon, authenticated;
grant execute on function app.replace_eur_equivalents(uuid, jsonb) to service_role;
grant execute on function app.eur_resolve_targets(uuid, int) to service_role;

-- 9. the public cards view: real EUR columns instead of P1's typed nulls (spec 6.6.4) --------------------------
-- Guard: the view must still have exactly P1's column list; if a later phase changed it, merge by hand instead of overwriting it.
do $$
declare
  v_expected text[] := array['scan_run_id','mode','rank','display_order','withheld','security_id','yahoo_symbol','name','exchange_code','exchange_name',
    'close','currency','session_date','threshold_line','lower_line_end','data_freshness','is_new_episode','since_date','operational_category',
    'category_reason','conclusion','bankruptcy_risk','summary','research_completed_at','report_id','eur_symbol_yahoo','ibkr_local_symbol',
    'ibkr_exchange_id','eur_status','eur_verified_at'];
  v_actual text[];
begin
  select array_agg(column_name::text order by ordinal_position) into v_actual
    from information_schema.columns where table_schema = 'public' and table_name = 'v_todays_discounts';
  if v_actual is distinct from v_expected then
    raise exception 'public.v_todays_discounts columns changed since P1 (%). Merge the eur_equivalents lateral join into the current definition by hand.', v_actual;
  end if;
end $$;

create or replace view public.v_todays_discounts with (security_invoker = true) as
select t.scan_run_id, t.mode, t.rank, t.display_order, t.withheld, s.id as security_id, s.yahoo_symbol, c.name, ex.code as exchange_code, ex.name as exchange_name,
       t.close, t.currency, t.session_date, t.threshold_line, t.lower_line_end, t.data_freshness, t.is_new_episode, e.opened_session_date as since_date,
       t.operational_category, t.category_reason, t.conclusion, t.bankruptcy_risk, t.summary, t.research_completed_at, t.report_id,
       eq.eur_symbol_yahoo, eq.ibkr_local_symbol, eq.ibkr_exchange_id, eq.status::text as eur_status, eq.verified_at as eur_verified_at
  from todays_discounts t
  join securities s on s.id = t.security_id
  join companies c on c.id = t.company_id
  join exchanges ex on ex.code = s.exchange_code
  join signal_episodes e on e.id = t.episode_id
  left join lateral (
    select q.* from eur_equivalents q
     where q.security_id = t.security_id
     order by case q.status when 'verified' then 0 when 'unverified' then 1 else 2 end, (q.ibkr_exchange_id = 'IBIS') desc
     limit 1
  ) eq on true
 where t.scan_run_id = (select id from scan_runs where results_published_at is not null order by scan_date_local desc limit 1);


-- 10. digest candidates: real EUR columns instead of P3's typed nulls (same signature and columns; grants are kept by create or replace)
create or replace function public.notify_discount_candidates(p_scan_run uuid, p_user uuid, p_finished_only boolean)
returns table (episode_id uuid, company_id uuid, security_id uuid, mode universe_mode, rank int, yahoo_symbol text,
  name text, close float8, currency text, session_date date, threshold_line text, category text, conclusion text,
  bankruptcy_risk text, summary text, eur_symbol text, eur_status text)
language sql stable security definer set search_path = public as $$
  select t.episode_id, t.company_id, t.security_id, t.mode, t.rank, s.yahoo_symbol, c.name, t.close, t.currency,
         t.session_date, t.threshold_line::text, t.operational_category::text, t.conclusion, t.bankruptcy_risk::text,
         coalesce(t.research_summary, t.summary, ''), eq.eur_symbol_yahoo, eq.status::text
    from todays_discounts t
    join securities s on s.id = t.security_id
    join companies c on c.id = t.company_id
    join notification_preferences p on p.user_id = p_user
    left join lateral (
      select q.eur_symbol_yahoo, q.status from eur_equivalents q
       where q.security_id = t.security_id
       order by case q.status when 'verified' then 0 when 'unverified' then 1 else 2 end, (q.ibkr_exchange_id = 'IBIS') desc
       limit 1
    ) eq on true
   where t.scan_run_id = p_scan_run
     and t.mode = any (p.digest_modes)
     and t.operational_category in ('green', 'amber')
     and not t.withheld
     and (not p_finished_only or (coalesce(t.research_report_id, t.report_id) is not null and t.research_completed_at is not null))
     and not exists (select 1 from digest_items i where i.user_id = p_user and i.ref_type = 'episode' and i.ref_id = t.episode_id)
   order by t.mode, t.rank, s.yahoo_symbol;
$$;