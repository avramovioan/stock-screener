-- Cross-user access matrix (spec 6.9, 15.3 and 17.2). The matrix below is the single declaration of who may do what.
-- When a migration adds a table, view or public function this file fails until the new object has an entry.
--   matrix.anon / matrix.auth : four characters = select, insert, update, delete.
--                               Y = table-level privilege, C = column-level privilege only, N = none.
--   owner_col                 : column holding auth.uid() on per-user tables (cross-user probes run for these).
--   hidden_where              : rows that anon and a signed-in non-holder, non-admin user must NOT see.
--   admin_reads               : an admin (profiles.is_admin) reads every row, including the ones hidden from others.
--   seed_override             : column values the generic seeder must use (check constraints, enum values).
--   skip_behaviour            : reason when the generic seed cannot satisfy a table (at most 5 rows may skip).
-- Actors: A and B are ordinary users, C is an admin. B additionally holds the security S (broker position and risk
-- monitor state), so B is the "holder" in the holder-only visibility assertions; A never holds S.
begin;
create extension if not exists pgtap with schema extensions;
truncate public.price_series, public.todays_discounts, public.signal_episodes, public.universe_membership_events, public.universe_snapshots, public.scan_security_results, public.scan_events, public.scan_jobs, public.market_cap_snapshots, public.scan_runs restart identity cascade;
set local session_replication_role = replica; -- seeds skip foreign keys and triggers

create temp table actors on commit drop as
  select '00000000-0000-0000-0000-00000000cc01'::uuid as a,
         '00000000-0000-0000-0000-00000000cc02'::uuid as b,
         '00000000-0000-0000-0000-00000000cc03'::uuid as c,
         '00000000-0000-0000-0000-00000000dd01'::uuid as s,   -- the security B holds
         '00000000-0000-0000-0000-00000000dd02'::uuid as rep; -- the holder-only report on S
grant select on actors to anon, authenticated;

create temp table matrix (
  tbl text primary key,
  anon text not null check (anon ~ '^[YCN]{4}$'),
  auth text not null check (auth ~ '^[YCN]{4}$'),
  owner_col text,
  hidden_where text,
  admin_reads boolean not null default false,
  seed_override jsonb not null default '{}'::jsonb,
  skip_behaviour text
) on commit drop;

insert into matrix (tbl, anon, auth, owner_col, hidden_where, admin_reads, seed_override) values
  -- public reference and result tables
  ('exchanges',                   'YNNN', 'YNNN', null, null, false, '{}'),
  ('fx_rates',                    'YNNN', 'YNNN', null, null, false, '{}'),
  ('companies',                   'YNNN', 'YNNN', null, null, false, '{}'),
  ('securities',                  'YNNN', 'YNNN', null, null, false, '{}'),
  ('eur_equivalents',             'YNNN', 'YNNN', null, null, false, '{}'),
  ('ibkr_catalogue',              'YNNN', 'YNNN', null, null, false, '{}'), -- deviation: P6 (public IBKR contract data; spec 6.9 says service role only)
  ('universe_snapshots',          'YNNN', 'YNNN', null, null, false, '{}'),
  ('universe_membership_events',  'YNNN', 'YNNN', null, null, false, '{}'),
  ('todays_discounts',            'YNNN', 'YNNN', null, null, false, '{}'),
  ('price_series',                'CNNN', 'CNNN', null, null, false, '{}'), -- arrays only through get_price_series (A-41)
  ('scan_runs',                   'CNNN', 'CNNN', null, null, false, '{}'), -- settings_snapshot, errors_summary, code_version hidden by column grants
  ('scan_security_results',       'CNNN', 'CNNN', null, $$scope <> 'universe'$$, false, '{"scope":"holding_only","status":"processed"}'),
  ('signal_episodes',             'YNNN', 'YNNN', null, $$kind <> 'discount'$$, false,
     '{"open_reason":"new_entry","kind":"premium1","threshold_line":"+1","mode":"worldwide","security_id":"00000000-0000-0000-0000-00000000dd01"}'),
  ('research_reports',            'YNNN', 'YNNN', null, $$visibility <> 'public'$$, false,
     '{"visibility":"holders","id":"00000000-0000-0000-0000-00000000dd02","security_id":"00000000-0000-0000-0000-00000000dd01"}'),
  ('research_sources',            'YNNN', 'YNNN', null, 'true', false, '{"report_id":"00000000-0000-0000-0000-00000000dd02","kind":"other","verification":"ok"}'),
  ('app_settings',                'YNNN', 'YNNN', null, 'not is_public', false, '{"is_public":false,"key":"p7_matrix_hidden"}'),
  -- service role only (no policy, no grant)
  ('security_identity_overrides', 'NNNN', 'NNNN', null, null, false, '{}'),
  ('market_cap_snapshots',        'NNNN', 'NNNN', null, null, false, '{}'),
  ('quote_cache',                 'NNNN', 'NNNN', null, null, false, '{}'),
  ('email_events',                'NNNN', 'NNNN', null, null, false, '{}'),
  ('research_work_texts',         'NNNN', 'NNNN', null, null, false, '{}'),
  ('invited_emails',              'NNNN', 'NNNN', null, null, false, '{}'),
  ('eur_equivalent_overrides',    'NNNN', 'NNNN', null, null, false, '{}'),
  ('ai_quota_usage',              'NNNN', 'NNNN', null, null, false, '{}'), -- deviation: spec 6.9 lists an optional admin read; none exists
  ('llm_model_state',             'NNNN', 'NNNN', null, null, false, '{}'), -- migration 20261015009300: the AI chain's per-model cooldown state, service role only
  -- admin-only reads
  ('scan_jobs',                   'NNNN', 'YNNN', null, 'true', true, '{}'),
  ('scan_events',                 'NNNN', 'YNNN', null, 'true', true, '{"level":"info"}'),
  -- admin reads everything, an actor reads the rows about themselves
  ('audit_events',                'NNNN', 'YNNN', 'actor_id', null, true, '{}'), -- deviation: P5a audit_events_select_own (spec 6.9: admin only)
  -- per-user tables (holder-only state is per user too)
  ('risk_monitor_state',          'NNNN', 'YNNN', 'user_id', null, false, '{"status":"active"}'),
  ('risk_findings',               'NNNN', 'YNNN', 'user_id', null, false, '{"category":"other","severity":"watch"}'),
  ('profiles',                    'NNNN', 'CNCN', 'user_id', null, false, '{}'),
  ('notification_preferences',    'NNNN', 'YCCN', 'user_id', null, false, '{}'),
  ('push_subscriptions',          'NNNN', 'CNNY', 'user_id', null, false, '{}'), -- deviation: P3 client may delete own subscription (spec 6.9: select only)
  ('digests',                     'NNNN', 'YNNN', 'user_id', null, false, '{"cutoff_reason":"complete","status":"ready"}'),
  ('digest_items',                'NNNN', 'YNNN', 'user_id', null, false, '{"ref_type":"episode"}'),
  ('digest_deliveries',           'NNNN', 'CNNN', 'user_id', null, false, '{}'),
  ('telegram_deliveries',         'NNNN', 'NNNN', null, null, false, '{}'), -- migration 20261015009800: the Telegram message of a public digest, service role only
  ('broker_connections',          'NNNN', 'CNNN', 'user_id', null, false, '{}'),
  ('broker_sync_runs',            'NNNN', 'CNNN', 'user_id', null, false, '{"kind":"daily"}'),
  ('broker_positions',            'NNNN', 'YNNN', 'user_id', null, false, '{"match_status":"matched_isin"}'),
  ('broker_trades',               'NNNN', 'YNNN', 'user_id', null, false, '{"buy_sell":"BUY"}'),
  ('broker_closed_lots',          'NNNN', 'YNNN', 'user_id', null, false, '{}'),
  ('broker_cash_transactions',    'NNNN', 'YNNN', 'user_id', null, false, '{"category":"other"}'),
  ('broker_corporate_actions',    'NNNN', 'YNNN', 'user_id', null, false, '{"kind":"transfer"}'),
  ('broker_fx_rates',             'NNNN', 'YNNN', 'user_id', null, false, '{}'),
  ('broker_nav',                  'NNNN', 'YNNN', 'user_id', null, false, '{}');

-- push_test_throttle (P3 follow-up migration 20261015004200): service role only. Added only when the migration is applied so
-- that this file also passes on a database that predates it; the coverage check still fails for any other unlisted table.
insert into matrix (tbl, anon, auth)
select 'push_test_throttle', 'NNNN', 'NNNN' where to_regclass('public.push_test_throttle') is not null;

create temp table view_matrix (vw text primary key, anon boolean not null, auth boolean not null) on commit drop;
insert into view_matrix values ('v_todays_discounts', true, true), ('v_card_research', true, true);

-- public functions: who may execute (by name; every overload shares the entry). Everything not listed is service role only.
create temp table fn_allow (proname text primary key, anon boolean not null, auth boolean not null) on commit drop;
insert into fn_allow values
  ('company_list', true, true), ('universe_summary', true, true), ('scan_status', true, true),
  ('get_price_series', true, true), ('todays_discounts_feed', true, true), ('research_quota_status', true, true),
  ('is_admin', false, true),           -- S-07 fixed in 20261015007000_security_grants.sql: RLS policies need authenticated, anon does not
  ('record_audit', false, true), ('holds_security', false, true), ('monitored_holdings_for', false, true);

-- app functions that anon/authenticated may execute: none (S-20 fixed in 20261015007000_security_grants.sql; default privileges of
-- schema app are closed). The table stays so that a deliberate exception needs an explicit, reviewed entry.
create temp table app_fn_allow (sig text primary key) on commit drop;

-- ---------------------------------------------------------------- helpers (run as the caller of the test, switch role inside)
create function pg_temp.set_caller(p_role text, p_uid uuid) returns void language plpgsql as $f$
begin
  execute format('set local role %I', p_role);
  perform set_config('request.jwt.claims',
    case when p_uid is null then json_build_object('role', p_role)::text
         else json_build_object('sub', p_uid, 'role', p_role)::text end, true);
end $f$;

create function pg_temp.priv_code(p_role text, p_tbl text, p_op text) returns text language sql stable as $f$
  select case
    when has_table_privilege(p_role, format('public.%I', p_tbl), upper(p_op)) then 'Y'
    when p_op <> 'delete' and has_any_column_privilege(p_role, format('public.%I', p_tbl), upper(p_op)) then 'C'
    else 'N' end
$f$;

-- One row document per table from the NOT NULL columns without default; p_role keeps only columns that role may insert.
create function pg_temp.build_doc(p_tbl text, p_owner uuid, p_extra jsonb default '{}'::jsonb, p_role text default null)
returns jsonb language plpgsql as $f$
declare
  a record; v_val jsonb; v_doc jsonb := '{}'::jsonb; v_over jsonb; v_owner_col text;
begin
  select seed_override, owner_col into v_over, v_owner_col from matrix where tbl = p_tbl;
  for a in
    select att.attname, att.atttypid, att.atttypmod, t.typtype, t.typcategory, t.typname
      from pg_attribute att join pg_type t on t.oid = att.atttypid
     where att.attrelid = format('public.%I', p_tbl)::regclass and att.attnum > 0 and not att.attisdropped
       and att.attnotnull and not att.atthasdef and att.attidentity = '' and att.attgenerated = ''
  loop
    v_val := case
      when a.typtype = 'e' then to_jsonb((select enumlabel from pg_enum where enumtypid = a.atttypid order by enumsortorder limit 1))
      when a.typname = 'uuid' then to_jsonb(gen_random_uuid()::text)
      when a.typcategory = 'A' then '[]'::jsonb
      when a.typname in ('jsonb', 'json') then '{}'::jsonb
      when a.typname = 'interval' then to_jsonb('1 day'::text)
      when a.typcategory = 'I' then to_jsonb('10.0.0.1'::text)
      when a.typcategory = 'N' then to_jsonb(1)
      when a.typname = 'bool' then to_jsonb(false)
      when a.typname = 'date' then to_jsonb('2026-10-15'::text)
      when a.typcategory = 'D' then to_jsonb(now()::text)
      when a.typname = 'bytea' then to_jsonb('\x00'::text)
      else to_jsonb(substr('x' || md5(random()::text), 1, case when a.atttypmod > 4 then least(a.atttypmod - 4, 9) else 9 end))
    end;
    v_doc := v_doc || jsonb_build_object(a.attname, v_val);
  end loop;
  v_doc := v_doc || coalesce(v_over, '{}'::jsonb) || coalesce(p_extra, '{}'::jsonb);
  if v_owner_col is not null and p_owner is not null then
    v_doc := v_doc || jsonb_build_object(v_owner_col, p_owner::text);
  end if;
  if p_role is not null then
    select coalesce(jsonb_object_agg(k, v_doc -> k), '{}'::jsonb) into v_doc
      from jsonb_object_keys(v_doc) k
     where has_column_privilege(p_role, format('public.%I', p_tbl), k, 'INSERT');
  end if;
  return v_doc;
end $f$;

create function pg_temp.seed_row(p_tbl text, p_owner uuid, p_extra jsonb default '{}'::jsonb) returns void language plpgsql as $f$
declare v_doc jsonb := pg_temp.build_doc(p_tbl, p_owner, p_extra); v_cols text;
begin
  select string_agg(format('%I', k), ', ') into v_cols from jsonb_object_keys(v_doc) k;
  execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I, $1)', p_tbl, v_cols, v_cols, p_tbl) using v_doc;
exception when others then
  raise exception 'seed failed for %: % (add a seed_override entry for this table in the matrix)', p_tbl, sqlerrm;
end $f$;

create function pg_temp.scalar_as(p_role text, p_uid uuid, p_sql text) returns text language plpgsql as $f$
declare v text;
begin
  perform pg_temp.set_caller(p_role, p_uid);
  execute p_sql into v;
  reset role;
  return v;
exception
  when insufficient_privilege then reset role; return 'denied';
  when others then reset role; return 'error:' || sqlstate;
end $f$;

create function pg_temp.dml_as(p_role text, p_uid uuid, p_sql text) returns text language plpgsql as $f$
declare n bigint;
begin
  perform pg_temp.set_caller(p_role, p_uid);
  execute p_sql;
  get diagnostics n = row_count;
  reset role;
  return 'rows:' || n;
exception
  when insufficient_privilege then reset role; return 'denied';
  when others then reset role; return 'passed:' || sqlstate;
end $f$;

-- 'denied' when privileges or a row policy refuse the insert; anything else (inserted, constraint error) passed access control.
create function pg_temp.insert_probe(p_tbl text, p_role text, p_uid uuid, p_owner uuid) returns text language plpgsql as $f$
declare v_doc jsonb := pg_temp.build_doc(p_tbl, p_owner, '{}'::jsonb, p_role); v_cols text;
begin
  if v_doc = '{}'::jsonb then return 'denied'; end if;
  select string_agg(format('%I', k), ', ') into v_cols from jsonb_object_keys(v_doc) k;
  begin
    perform pg_temp.set_caller(p_role, p_uid);
    execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I, $1)', p_tbl, v_cols, v_cols, p_tbl) using v_doc;
    reset role;
    raise exception using errcode = 'P0001', message = 'probe_inserted'; -- undo the row
  exception
    when insufficient_privilege then reset role; return 'denied';
    when sqlstate 'P0001' then reset role; return 'inserted';
    when others then reset role; return 'passed:' || sqlstate;
  end;
end $f$;

-- a column of the table that authenticated may both read and update (null when there is none)
create function pg_temp.update_col(p_tbl text) returns text language sql stable as $f$
  select a.attname::text from pg_attribute a
   where a.attrelid = format('public.%I', p_tbl)::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', a.attrelid, a.attnum, 'UPDATE')
     and has_column_privilege('authenticated', a.attrelid, a.attnum, 'SELECT')
   order by a.attnum limit 1
$f$;

create function pg_temp.expected_of(p_kind text, p_tbl text) returns text language plpgsql as $f$
declare m record; v text;
begin
  select * into m from matrix where tbl = p_tbl;
  if p_kind like 'priv.%' then
    return substr(case split_part(p_kind, '.', 2) when 'anon' then m.anon else m.auth end,
                  array_position(array['select','insert','update','delete'], split_part(p_kind, '.', 3)), 1);
  end if;
  case p_kind
    when 'own_count' then return case when substr(m.auth, 1, 1) = 'N' then 'denied' else '1' end;
    when 'anon_count' then return case when substr(m.anon, 1, 1) = 'N' then 'denied' else '0' end;
    when 'cross_insert' then return 'denied';
    when 'cross_update' then return 'blocked';
    when 'cross_delete' then return 'blocked';
    when 'own_insert' then return 'allowed';
    when 'own_update' then return 'rows:1';
    when 'own_delete' then return 'rows:1';
    when 'hidden_anon' then
      if substr(m.anon, 1, 1) = 'N' then return 'denied'; end if;
      execute format('select count(*)::text from public.%I where not (%s)', p_tbl, m.hidden_where) into v;
      return v;
    when 'hidden_auth' then
      if substr(m.auth, 1, 1) = 'N' then return 'denied'; end if;
      execute format('select count(*)::text from public.%I where not (%s)', p_tbl, m.hidden_where) into v;
      return v;
    when 'admin_count' then
      execute format('select count(*)::text from public.%I', p_tbl) into v;
      return v;
    else raise exception 'unknown check kind %', p_kind;
  end case;
end $f$;

create function pg_temp.actual_of(p_kind text, p_tbl text) returns text language plpgsql as $f$
declare
  v_a uuid := (select a from actors); v_b uuid := (select b from actors); v_c uuid := (select c from actors);
  v_own text; v_ucol text; v_res text; v_count text := format('select count(*)::text from public.%I', p_tbl);
begin
  select owner_col into v_own from matrix where tbl = p_tbl;
  v_ucol := pg_temp.update_col(p_tbl);
  if p_kind like 'priv.%' then
    return pg_temp.priv_code(split_part(p_kind, '.', 2), p_tbl, split_part(p_kind, '.', 3));
  end if;
  case p_kind
    when 'own_count' then return pg_temp.scalar_as('authenticated', v_a, v_count);
    when 'anon_count' then return pg_temp.scalar_as('anon', null, v_count);
    when 'hidden_anon' then return pg_temp.scalar_as('anon', null, v_count);
    when 'hidden_auth' then return pg_temp.scalar_as('authenticated', v_a, v_count);
    when 'admin_count' then return pg_temp.scalar_as('authenticated', v_c, v_count);
    when 'cross_insert' then
      v_res := pg_temp.insert_probe(p_tbl, 'authenticated', v_a, v_b);
      return case when v_res = 'denied' then 'denied' else 'allowed' end;
    when 'own_insert' then
      v_res := pg_temp.insert_probe(p_tbl, 'authenticated', v_a, v_a);
      return case when v_res = 'denied' then 'denied' else 'allowed' end;
    when 'cross_update' then
      if v_ucol is null then return 'blocked'; end if; -- no updatable column at all: nothing to attempt
      v_res := pg_temp.dml_as('authenticated', v_a, format('update public.%I set %I = %I where %I = %L', p_tbl, v_ucol, v_ucol, v_own, v_b));
      return case when v_res in ('denied', 'rows:0') then 'blocked' else 'LEAK ' || v_res end;
    when 'cross_delete' then
      v_res := pg_temp.dml_as('authenticated', v_a, format('delete from public.%I where %I = %L', p_tbl, v_own, v_b));
      return case when v_res in ('denied', 'rows:0') then 'blocked' else 'LEAK ' || v_res end;
    when 'own_update' then
      return pg_temp.dml_as('authenticated', v_a, format('update public.%I set %I = %I where %I = %L', p_tbl, v_ucol, v_ucol, v_own, v_a));
    when 'own_delete' then
      return pg_temp.dml_as('authenticated', v_a, format('delete from public.%I where %I = %L', p_tbl, v_own, v_a));
    else raise exception 'unknown check kind %', p_kind;
  end case;
end $f$;

-- ---------------------------------------------------------------- seeds (two users, one admin; one hidden row per hidden table)
do $seed$
declare m record; v_a uuid := (select a from actors); v_b uuid := (select b from actors); v_c uuid := (select c from actors); v_s uuid := (select s from actors);
begin
  insert into auth.users (id, email) values (v_a, 'matrix-a@example.test'), (v_b, 'matrix-b@example.test'), (v_c, 'matrix-admin@example.test');
  for m in select * from matrix where skip_behaviour is null order by tbl loop
    if m.owner_col is not null then
      perform pg_temp.seed_row(m.tbl, v_a);
      perform pg_temp.seed_row(m.tbl, v_b);
    elsif m.hidden_where is not null then
      perform pg_temp.seed_row(m.tbl, null);
    end if;
  end loop;
  perform pg_temp.seed_row('profiles', v_c, '{"is_admin": true}'::jsonb);
  -- B holds S: the holder predicates of research_reports (app.holder: risk monitor) and signal_episodes (holds_security: broker position)
  update public.broker_positions set security_id = v_s, signal_security_id = v_s where user_id = v_b;
  update public.risk_monitor_state set security_id = v_s where user_id = v_b;
end $seed$;

-- ---------------------------------------------------------------- check descriptors (no execution: the plan count comes from these)
create temp view checks as
select row_number() over (order by grp, tbl, kind) as ord, kind, tbl, descr
  from (
    select 1 as grp, 'priv.' || r.role || '.' || o.op as kind, m.tbl,
           format('%s: %s may %s as declared', m.tbl, r.role, o.op) as descr
      from matrix m cross join (values ('anon'), ('authenticated')) r(role)
           cross join (values ('select'), ('insert'), ('update'), ('delete')) o(op)
    union all
    select 2, k.kind, m.tbl, format('%s: %s', m.tbl, k.kind)
      from matrix m cross join (values ('own_count'), ('anon_count'), ('cross_insert'), ('cross_update'), ('cross_delete')) k(kind)
     where m.owner_col is not null and m.skip_behaviour is null
    union all
    select 2, 'own_insert', m.tbl, format('%s: own_insert', m.tbl)
      from matrix m where m.owner_col is not null and m.skip_behaviour is null and substr(m.auth, 2, 1) = 'Y'
    union all
    select 2, 'own_update', m.tbl, format('%s: own_update', m.tbl)
      from matrix m where m.owner_col is not null and m.skip_behaviour is null and substr(m.auth, 3, 1) <> 'N'
    union all
    select 2, k.kind, m.tbl, format('%s: %s', m.tbl, k.kind)
      from matrix m cross join (values ('hidden_anon'), ('hidden_auth')) k(kind)
     where m.hidden_where is not null and m.skip_behaviour is null
    union all
    select 2, 'admin_count', m.tbl, format('%s: an admin reads the admin-only rows', m.tbl)
      from matrix m where m.admin_reads and m.skip_behaviour is null and substr(m.auth, 1, 1) <> 'N'
    union all
    select 3, 'own_delete', m.tbl, format('%s: own_delete', m.tbl) -- destructive: runs last
      from matrix m where m.owner_col is not null and m.skip_behaviour is null and substr(m.auth, 4, 1) = 'Y'
  ) all_checks;

create temp view public_functions as
select p.oid, p.proname, p.oid::regprocedure::text as sig
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.prorettype <> 'trigger'::regtype
   and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e');

create temp view fn_checks as
select f.sig, r.role,
       case r.role when 'anon' then coalesce(a.anon, false) else coalesce(a.auth, false) end as expected,
       has_function_privilege(r.role, f.oid, 'execute') as actual
  from public_functions f cross join (values ('anon'), ('authenticated')) r(role)
       left join fn_allow a on a.proname = f.proname;

create temp view view_checks as
select m.vw, r.role as what, case r.role when 'anon' then m.anon else m.auth end as expected,
       has_table_privilege(r.role, format('public.%I', m.vw), 'select') as actual
  from view_matrix m cross join (values ('anon'), ('authenticated')) r(role)
union all
select m.vw, 'security_invoker', true,
       coalesce((select 'security_invoker=true' = any (c.reloptions) from pg_class c where c.oid = format('public.%I', m.vw)::regclass), false)
  from view_matrix m;

select plan((select count(*)::int from checks) + (select count(*)::int from fn_checks) + (select count(*)::int from view_checks) + 11 + 9 + 4);

-- ---------------------------------------------------------------- coverage and structure (11 assertions)
select is((select coalesce(string_agg(t.tablename, ', ' order by t.tablename), '') from pg_tables t
            where t.schemaname = 'public' and t.tablename not in (select tbl from matrix)),
          '', 'every public table has a matrix entry');
select is((select coalesce(string_agg(m.tbl, ', ' order by m.tbl), '') from matrix m where to_regclass(format('public.%I', m.tbl)) is null),
          '', 'every matrix entry names an existing table');
select is((select coalesce(string_agg(c.relname, ', ' order by c.relname), '') from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity),
          '', 'row level security is enabled on every public table');
select is((select coalesce(string_agg(v.viewname, ', ' order by v.viewname), '') from pg_views v
            where v.schemaname = 'public' and v.viewname not in (select vw from view_matrix)),
          '', 'every public view has a view matrix entry');
select is((select coalesce(string_agg(m.vw, ', ' order by m.vw), '') from view_matrix m where to_regclass(format('public.%I', m.vw)) is null),
          '', 'every view matrix entry names an existing view');
select ok(not has_schema_privilege('anon', 'app', 'usage') and not has_schema_privilege('authenticated', 'app', 'usage'),
          'schema app has no usage for anon and authenticated');
select is((select coalesce(string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text), '')
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'app' and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))
              and p.oid::regprocedure::text not in (select sig from app_fn_allow)),
          '', 'no app function outside the pinned allow-list is executable by anon or authenticated');
select ok((select count(*) from matrix where skip_behaviour is not null) <= 5, 'at most five tables skip the behavioural probes');
select is((select coalesce(string_agg(a.proname, ', ' order by a.proname), '') from fn_allow a where a.proname not in (select proname from public_functions)),
          '', 'every function allow-list entry names an existing public function');
select is((select coalesce(string_agg(p.tablename || '.' || p.policyname, ', ' order by p.tablename, p.policyname), '')
             from pg_policies p join matrix m on m.tbl = p.tablename
            where p.schemaname = 'public' and m.owner_col is not null and ('anon' = any (p.roles) or 'public' = any (p.roles))),
          '', 'no policy of a per-user table applies to anon or PUBLIC');
select is((select coalesce(string_agg(p.tablename || '.' || p.policyname, ', ' order by p.tablename, p.policyname), '')
             from pg_policies p join matrix m on m.tbl = p.tablename
            where p.schemaname = 'public' and m.owner_col is not null
              and (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) not like '%auth.uid()%'
              and (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) not like '%is_admin()%'),
          '', 'every policy of a per-user table is bound to auth.uid() (or is the admin policy)');

-- ---------------------------------------------------------------- the matrix, row by row
select is(pg_temp.actual_of(c.kind, c.tbl), pg_temp.expected_of(c.kind, c.tbl), c.descr)
  from (select * from checks order by ord offset 0) c;

select is(f.actual, f.expected, format('%s: %s may execute', f.sig, f.role))
  from (select * from fn_checks order by sig, role offset 0) f;

select is(v.actual, v.expected, format('%s: %s', v.vw, v.what))
  from (select * from view_checks order by vw, what offset 0) v;

-- ---------------------------------------------------------------- holder-only rows: visible to the holder (B), invisible to anon and to A
select is(pg_temp.scalar_as('authenticated', (select b from actors), $$select count(*)::text from public.signal_episodes where security_id = (select s from actors)$$),
          '1', 'holder B sees the premium episode of S');
select is(pg_temp.scalar_as('authenticated', (select b from actors), $$select count(*)::text from public.research_reports where id = (select rep from actors)$$),
          '1', 'holder B sees the holders-only report on S');
select is(pg_temp.scalar_as('authenticated', (select b from actors), $$select count(*)::text from public.research_sources where report_id = (select rep from actors)$$),
          '1', 'holder B sees the sources of the holders-only report');
select is(pg_temp.scalar_as('authenticated', (select a from actors), $$select count(*)::text from public.signal_episodes where security_id = (select s from actors)$$),
          '0', 'non-holder A does not see the premium episode of S');
select is(pg_temp.scalar_as('authenticated', (select a from actors), $$select count(*)::text from public.research_reports where id = (select rep from actors)$$),
          '0', 'non-holder A does not see the holders-only report on S');
select is(pg_temp.scalar_as('authenticated', (select a from actors), $$select count(*)::text from public.research_sources where report_id = (select rep from actors)$$),
          '0', 'non-holder A does not see the sources of the holders-only report');
select is(pg_temp.scalar_as('anon', null, $$select count(*)::text from public.signal_episodes where security_id = (select s from actors)$$),
          '0', 'anon does not see the premium episode of S');
select is(pg_temp.scalar_as('anon', null, $$select count(*)::text from public.research_reports where id = (select rep from actors)$$),
          '0', 'anon does not see the holders-only report on S');
select is(pg_temp.scalar_as('anon', null, $$select count(*)::text from public.research_sources where report_id = (select rep from actors)$$),
          '0', 'anon does not see the sources of the holders-only report');

-- ---------------------------------------------------------------- notification_preferences.digest_country_filter (20261015007800): own row only, anon nothing (4 assertions)
insert into public.notification_preferences (user_id) select a from actors union select b from actors on conflict (user_id) do nothing;
select ok(has_column_privilege('authenticated', 'public.notification_preferences', 'digest_country_filter', 'SELECT')
      and has_column_privilege('authenticated', 'public.notification_preferences', 'digest_country_filter', 'UPDATE'),
          'authenticated holds column select and update on notification_preferences.digest_country_filter');
select is(pg_temp.dml_as('anon', null, format('update public.notification_preferences set digest_country_filter = ''United States'' where user_id = %L', (select a from actors))),
          'denied', 'anon cannot update notification_preferences.digest_country_filter');
select is(pg_temp.dml_as('authenticated', (select a from actors), format('update public.notification_preferences set digest_country_filter = ''United States'' where user_id = %L', (select a from actors))),
          'rows:1', 'a user updates the digest_country_filter of their own preferences');
select is(pg_temp.dml_as('authenticated', (select a from actors), format('update public.notification_preferences set digest_country_filter = ''United States'' where user_id = %L', (select b from actors))),
          'rows:0', 'a user cannot update the digest_country_filter of another user');

select * from finish();
rollback;
