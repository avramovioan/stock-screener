-- Primary listing rule (migration 20261015008400, A-50): companies.exclusion_reason and app.apply_identity_groups.
-- 15 assertions.
begin;
create extension if not exists pgtap with schema extensions;
truncate public.securities, public.companies, public.todays_discounts, public.signal_episodes, public.universe_membership_events, public.universe_snapshots, public.scan_security_results, public.scan_events, public.scan_jobs, public.market_cap_snapshots, public.scan_runs restart identity cascade;
select plan(15);

-- column --------------------------------------------------------------------------------------------------------------
select has_column('public', 'companies', 'exclusion_reason', 'companies.exclusion_reason exists');
select col_type_is('public', 'companies', 'exclusion_reason', 'text', 'exclusion_reason is text');
select col_is_null('public', 'companies', 'exclusion_reason', 'exclusion_reason is nullable (existing rows stay null)');
select col_hasnt_default('public', 'companies', 'exclusion_reason', 'exclusion_reason has no default');

-- fixtures: IDEXX has only the London international order book line, canonical from an earlier scan --------------------
create function pg_temp.uid(p_kind int, p_i int) returns uuid language sql immutable as $$
  select ('00000000-0000-0000-' || lpad(p_kind::text, 4, '0') || '-' || lpad(p_i::text, 12, '0'))::uuid
$$;
insert into companies (id, name, name_normalized, country) values (pg_temp.uid(1, 1), 'IDEXX Laboratories, Inc.', 'idexx laboratories', 'United States');
insert into securities (id, company_id, yahoo_symbol, exchange_code, currency, currency_major, quote_type, is_canonical, role)
values (pg_temp.uid(2, 1), pg_temp.uid(1, 1), '0J8P.L', 'LSE', 'USD', 'USD', 'EQUITY', true, 'canonical');
update companies set canonical_security_id = pg_temp.uid(2, 1) where id = pg_temp.uid(1, 1);

-- 1. the group job found no primary listing: the canonical is cleared and the reason recorded -----------------------------
select app.apply_identity_groups(jsonb_build_array(jsonb_build_object(
  'company_id', pg_temp.uid(1, 1), 'member_ids', jsonb_build_array(pg_temp.uid(2, 1)), 'canonical_id', null,
  'roles', jsonb_build_object(pg_temp.uid(2, 1)::text, 'secondary_venue'),
  'country', 'United States', 'name', 'IDEXX Laboratories, Inc.', 'name_normalized', 'idexx laboratories', 'exclusion_reason', 'no_primary_listing')));
select is((select exclusion_reason from companies where id = pg_temp.uid(1, 1)), 'no_primary_listing', 'the exclusion reason is recorded');
select is((select canonical_security_id from companies where id = pg_temp.uid(1, 1)), null, 'the company has no canonical security');
select is((select is_canonical from securities where id = pg_temp.uid(2, 1)), false, 'the IOB line is no longer canonical');
select is((select role from securities where id = pg_temp.uid(2, 1)), 'secondary_venue', 'the IOB line keeps its secondary_venue role');
select is((select status from companies where id = pg_temp.uid(1, 1)), 'active', 'an excluded company stays active (it is reported, not deleted)');

-- 2. the US listing arrives: it becomes canonical at once and the reason is cleared ---------------------------------------
insert into securities (id, company_id, yahoo_symbol, exchange_code, currency, currency_major, quote_type)
values (pg_temp.uid(2, 2), pg_temp.uid(1, 1), 'IDXX', 'NMS', 'USD', 'USD', 'EQUITY');
select app.apply_identity_groups(jsonb_build_array(jsonb_build_object(
  'company_id', pg_temp.uid(1, 1), 'member_ids', jsonb_build_array(pg_temp.uid(2, 1), pg_temp.uid(2, 2)), 'canonical_id', pg_temp.uid(2, 2),
  'roles', jsonb_build_object(pg_temp.uid(2, 1)::text, 'secondary_venue', pg_temp.uid(2, 2)::text, 'canonical'),
  'country', 'United States', 'name', 'IDEXX Laboratories, Inc.', 'name_normalized', 'idexx laboratories', 'exclusion_reason', null)));
select is((select exclusion_reason from companies where id = pg_temp.uid(1, 1)), null, 'the reason is cleared when a canonical listing exists');
select is((select yahoo_symbol from securities where is_canonical and company_id = pg_temp.uid(1, 1)), 'IDXX', 'the US line is canonical');
select is((select count(*)::int from securities where is_canonical and company_id = pg_temp.uid(1, 1)), 1, 'exactly one canonical security');

-- 3. a stale reason cannot survive next to a canonical security even if the payload carries one -----------------------
select app.apply_identity_groups(jsonb_build_array(jsonb_build_object(
  'company_id', pg_temp.uid(1, 1), 'member_ids', jsonb_build_array(pg_temp.uid(2, 1), pg_temp.uid(2, 2)), 'canonical_id', pg_temp.uid(2, 2),
  'roles', jsonb_build_object(pg_temp.uid(2, 2)::text, 'canonical'), 'exclusion_reason', 'country_unknown')));
select is((select exclusion_reason from companies where id = pg_temp.uid(1, 1)), null, 'a canonical security always clears the reason');

-- 4. only the three documented reasons are accepted ------------------------------------------------------------------------
select throws_ok(
  $$update companies set exclusion_reason = 'because' where id = '00000000-0000-0000-0001-000000000001'$$,
  '23514', null, 'an unknown reason violates the check constraint');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app' and p.proname = 'apply_identity_groups' and p.prosecdef),
  1, 'apply_identity_groups stays a single security definer function');

select * from finish();
rollback;
