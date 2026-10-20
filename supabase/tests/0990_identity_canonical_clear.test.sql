-- Identity canonical clear (migration 20261015008600): app.apply_identity_groups clears the target company's other canonical
-- securities before setting the group's canonical, and reports how many it displaced. 12 assertions.
begin;
create extension if not exists pgtap with schema extensions;
truncate public.securities, public.companies, public.todays_discounts, public.signal_episodes, public.universe_membership_events, public.universe_snapshots, public.scan_security_results, public.scan_events, public.scan_jobs, public.market_cap_snapshots, public.scan_runs restart identity cascade;
select plan(12);

create function pg_temp.uid(p_kind int, p_i int) returns uuid language sql immutable as $$
  select ('00000000-0000-0000-' || lpad(p_kind::text, 4, '0') || '-' || lpad(p_i::text, 12, '0'))::uuid
$$;

-- fixtures: company C holds S_old as canonical; S_new is a second listing that is not yet canonical -----------------------
insert into companies (id, name, name_normalized, country) values (pg_temp.uid(1, 1), 'Split Corp', 'split corp', 'United States');
insert into securities (id, company_id, yahoo_symbol, exchange_code, currency, currency_major, quote_type, is_canonical, role)
values (pg_temp.uid(2, 1), pg_temp.uid(1, 1), 'SPL.SW', 'EBS', 'CHF', 'CHF', 'EQUITY', true, 'canonical');
insert into securities (id, company_id, yahoo_symbol, exchange_code, currency, currency_major, quote_type)
values (pg_temp.uid(2, 2), pg_temp.uid(1, 1), 'SPL', 'NMS', 'USD', 'USD', 'EQUITY');
update companies set canonical_security_id = pg_temp.uid(2, 1) where id = pg_temp.uid(1, 1);

-- 1. the group does not contain S_old: it is displaced instead of colliding on securities_one_canonical -------------------
create temp table r1 as select app.apply_identity_groups(jsonb_build_array(jsonb_build_object(
  'company_id', pg_temp.uid(1, 1), 'member_ids', jsonb_build_array(pg_temp.uid(2, 2)), 'canonical_id', pg_temp.uid(2, 2),
  'roles', jsonb_build_object(pg_temp.uid(2, 2)::text, 'canonical'),
  'country', 'United States', 'name', 'Split Corp', 'name_normalized', 'split corp', 'exclusion_reason', null))) as r;
select is((select (r ->> 'groups')::int from r1), 1, 'the group was applied without a unique violation');
select is((select is_canonical from securities where id = pg_temp.uid(2, 2)), true, 'S_new is canonical');
select is((select role from securities where id = pg_temp.uid(2, 2)), 'canonical', 'S_new has the canonical role');
select is((select is_canonical from securities where id = pg_temp.uid(2, 1)), false, 'S_old is no longer canonical');
select is((select role from securities where id = pg_temp.uid(2, 1)), 'other', 'S_old falls back to the other role');
select is((select canonical_security_id from companies where id = pg_temp.uid(1, 1)), pg_temp.uid(2, 2), 'the company points at S_new');
select is((select (r ->> 'canonical_displaced')::int from r1), 1, 'one canonical was displaced');
select is((select count(*)::int from securities where is_canonical and company_id = pg_temp.uid(1, 1)), 1, 'exactly one canonical security');

-- 2. the ordinary switch: S_old is a member, nothing outside the group is displaced -----------------------------------------
create temp table r2 as select app.apply_identity_groups(jsonb_build_array(jsonb_build_object(
  'company_id', pg_temp.uid(1, 1), 'member_ids', jsonb_build_array(pg_temp.uid(2, 1), pg_temp.uid(2, 2)), 'canonical_id', pg_temp.uid(2, 1),
  'roles', jsonb_build_object(pg_temp.uid(2, 1)::text, 'canonical', pg_temp.uid(2, 2)::text, 'foreign_listing'),
  'country', 'United States', 'name', 'Split Corp', 'name_normalized', 'split corp', 'exclusion_reason', null))) as r;
select is((select (r ->> 'canonical_displaced')::int from r2), 0, 'a member canonical is not counted as displaced');
select is((select is_canonical from securities where id = pg_temp.uid(2, 1)), true, 'S_old is canonical again');
select is((select role from securities where id = pg_temp.uid(2, 2)), 'foreign_listing', 'S_new keeps the role from the group');
select is((select count(*)::int from securities where is_canonical and company_id = pg_temp.uid(1, 1)), 1, 'still exactly one canonical security');

select * from finish();
rollback;
