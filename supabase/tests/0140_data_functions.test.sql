begin;
create extension if not exists pgtap with schema extensions;
truncate public.securities, public.companies, public.todays_discounts, public.signal_episodes, public.universe_membership_events, public.universe_snapshots, public.scan_security_results, public.scan_events, public.scan_jobs, public.market_cap_snapshots, public.scan_runs restart identity cascade;
select plan(32);

insert into scan_runs (id, scan_date_local, settings_snapshot) values ('00000000-0000-0000-0000-0000000000f1', '2030-02-01', '{}');

create function pg_temp.row(p_symbol text, p_exchange text, p_cap float8, p_extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('yahoo_symbol', p_symbol, 'new_company_id', gen_random_uuid(), 'name', p_symbol || ' Corp', 'name_normalized', lower(p_symbol),
         'exchange_code', p_exchange, 'currency', 'USD', 'currency_major', 'USD', 'minor_divisor', 1, 'quote_type', 'EQUITY', 'long_name', p_symbol || ' Corp',
         'financial_currency', 'USD', 'shares_outstanding', 1000, 'first_trade_date', '1999-01-22', 'market_cap_native', p_cap, 'fx_usd_per_unit', 1,
         'fx_rate_date', '2030-01-31', 'fx_source', 'frankfurter', 'market_cap_usd', p_cap, 'price_time', '2030-01-31T21:00:00Z', 'source', 'yahoo_screener',
         'quality', 'ok') || p_extra
$$;

-- apply_quote_rows -------------------------------------------------------------------------------------------
select is(app.apply_quote_rows('00000000-0000-0000-0000-0000000000f1', jsonb_build_array(pg_temp.row('AAA', 'NMS', 6e10), pg_temp.row('BBB', 'GER', 5e10))),
          '{"created":2,"updated":0,"snapshots":2,"skipped_unknown_exchange":0}'::jsonb, 'two new securities are created with their snapshots');
select is((select count(*)::int from securities where yahoo_symbol in ('AAA', 'BBB')), 2, 'securities exist');
select is((select count(*)::int from companies c join securities s on s.company_id = c.id where s.yahoo_symbol = 'AAA' and c.name = 'AAA Corp'), 1, 'a provisional company was created for AAA');
select is((select (select count(*)::int from securities s2 where s2.company_id = s.company_id) from securities s where s.yahoo_symbol = 'AAA'), 1, 'every new security starts alone in its company');
select is((select market_cap_usd from market_cap_snapshots m join securities s on s.id = m.security_id where s.yahoo_symbol = 'AAA'), 6e10::float8, 'the snapshot carries the USD market cap');
select is((select first_trade_date from securities where yahoo_symbol = 'AAA'), '1999-01-22'::date, 'first_trade_date stored');

select is(app.apply_quote_rows('00000000-0000-0000-0000-0000000000f1', jsonb_build_array(pg_temp.row('AAA', 'NMS', 7e10, '{"source":"yahoo_quote","long_name":null,"shares_outstanding":null}'))),
          '{"created":0,"updated":1,"snapshots":1,"skipped_unknown_exchange":0}'::jsonb, 'a second call updates instead of duplicating (idempotent)');
select is((select count(*)::int from securities where yahoo_symbol = 'AAA'), 1, 'still one AAA security');
select is((select count(*)::int from companies where name = 'AAA Corp'), 1, 'no second company for a known security');
select is((select market_cap_usd from market_cap_snapshots m join securities s on s.id = m.security_id where s.yahoo_symbol = 'AAA'), 7e10::float8, 'the snapshot of the run is replaced');
select is((select source from market_cap_snapshots m join securities s on s.id = m.security_id where s.yahoo_symbol = 'AAA'), 'yahoo_quote', 'with its new source');
select is((select long_name || ' ' || shares_outstanding from securities where yahoo_symbol = 'AAA'), 'AAA Corp 1000', 'a missing value never nulls a known one');

select is(app.apply_quote_rows('00000000-0000-0000-0000-0000000000f1', jsonb_build_array(pg_temp.row('ZZZ', 'NOPE', 1e10))),
          '{"created":0,"updated":0,"snapshots":0,"skipped_unknown_exchange":1}'::jsonb, 'an unknown exchange code is skipped, not an error');
select is((select count(*)::int from securities where yahoo_symbol = 'ZZZ'), 0, 'nothing is created for it');

select is(app.apply_quote_rows('00000000-0000-0000-0000-0000000000f1', jsonb_build_array(pg_temp.row('SHEL.L', 'LSE', 2.2e11, '{"currency":"GBp","currency_major":"GBP","minor_divisor":100,"fx_usd_per_unit":1.325,"market_cap_usd":2.9e11}'))) ->> 'created', '1', 'a GBp listing is created');
select is((select currency || '/' || currency_major || '/' || minor_divisor from securities where yahoo_symbol = 'SHEL.L'), 'GBp/GBP/100', 'minor unit, major unit and divisor are stored');
select is((select market_cap_native from market_cap_snapshots m join securities s on s.id = m.security_id where s.yahoo_symbol = 'SHEL.L'), 2.2e11::float8, 'the native market cap is stored as reported (GBP, not divided)');

update securities set status = 'delisted', missing_scans = 3 where yahoo_symbol = 'BBB';
select app.apply_quote_rows('00000000-0000-0000-0000-0000000000f1', jsonb_build_array(pg_temp.row('BBB', 'GER', 5e10)));
select is((select status || ':' || missing_scans from securities where yahoo_symbol = 'BBB'), 'active:0', 'seeing a security again reactivates it and resets missing_scans');

-- apply_identity_groups --------------------------------------------------------------------------------------
select app.apply_quote_rows('00000000-0000-0000-0000-0000000000f1', jsonb_build_array(pg_temp.row('MSFT', 'NMS', 4e12), pg_temp.row('MSF.DE', 'GER', 3.9e12), pg_temp.row('MSF.F', 'GER', 3.9e12)));
create temp table ids as select yahoo_symbol, id, company_id from securities where yahoo_symbol in ('MSFT', 'MSF.DE', 'MSF.F');
create temp table g as select jsonb_build_array(jsonb_build_object(
  'company_id', (select company_id from ids where yahoo_symbol = 'MSFT'),
  'member_ids', (select jsonb_agg(id) from ids),
  'canonical_id', (select id from ids where yahoo_symbol = 'MSFT'),
  'roles', (select jsonb_object_agg(id::text, case yahoo_symbol when 'MSFT' then 'canonical' when 'MSF.DE' then 'foreign_listing' else 'secondary_venue' end) from ids),
  'country', 'United States', 'name', 'Microsoft Corporation', 'name_normalized', 'microsoft')) as j;
select is(app.apply_identity_groups((select j from g)) ->> 'groups', '1', 'one group applied');
select is((select count(distinct company_id)::int from securities where yahoo_symbol in ('MSFT', 'MSF.DE', 'MSF.F')), 1, 'the three listings share one company');
select is((select role from securities where yahoo_symbol = 'MSF.DE'), 'foreign_listing', 'roles are applied');
select is((select is_canonical from securities where yahoo_symbol = 'MSFT'), true, 'the canonical flag is set');
select is((select count(*)::int from securities where yahoo_symbol in ('MSFT', 'MSF.DE', 'MSF.F') and is_canonical), 1, 'exactly one canonical security');
select is((select c.canonical_security_id from companies c join securities s on s.company_id = c.id where s.yahoo_symbol = 'MSFT'), (select id from ids where yahoo_symbol = 'MSFT'), 'the company points at its canonical security');
select is((select c.country || ' / ' || c.name from companies c join securities s on s.company_id = c.id where s.yahoo_symbol = 'MSFT'), 'United States / Microsoft Corporation', 'company country and name are set');
select is((select count(*)::int from companies where id in (select company_id from ids where yahoo_symbol in ('MSF.DE', 'MSF.F'))), 0, 'the provisional companies of the merged listings were deleted');

-- re-applying with a different canonical switches the flag without violating the one-canonical index
create temp table g2 as select jsonb_build_array(jsonb_build_object(
  'company_id', (select company_id from ids where yahoo_symbol = 'MSFT'),
  'member_ids', (select jsonb_agg(id) from ids),
  'canonical_id', (select id from ids where yahoo_symbol = 'MSF.DE'),
  'roles', (select jsonb_object_agg(id::text, case yahoo_symbol when 'MSF.DE' then 'canonical' when 'MSFT' then 'share_class' else 'secondary_venue' end) from ids))) as j;
select lives_ok($$select app.apply_identity_groups((select j from g2))$$, 'switching the canonical listing is accepted');
select is((select yahoo_symbol from securities where is_canonical and yahoo_symbol in ('MSFT', 'MSF.DE', 'MSF.F')), 'MSF.DE', 'the new canonical is MSF.DE');
select is((select count(*)::int from securities where yahoo_symbol in ('MSFT', 'MSF.DE', 'MSF.F') and is_canonical), 1, 'still exactly one canonical security');

-- an orphaned company that an old snapshot still references is deactivated, not deleted
select app.apply_quote_rows('00000000-0000-0000-0000-0000000000f1', jsonb_build_array(pg_temp.row('OLD1', 'NMS', 6e10)));
insert into scan_runs (id, scan_date_local, settings_snapshot) values ('00000000-0000-0000-0000-0000000000f2', '2030-02-02', '{}');
insert into universe_snapshots (scan_run_id, mode, security_id, company_id, rank, market_cap_usd, is_top10, applicable_line)
select '00000000-0000-0000-0000-0000000000f2', 'worldwide', id, company_id, 1, 6e10, true, '-3' from securities where yahoo_symbol = 'OLD1';
create temp table old as select id, company_id from securities where yahoo_symbol = 'OLD1';
select app.apply_identity_groups(jsonb_build_array(jsonb_build_object(
  'company_id', (select company_id from ids where yahoo_symbol = 'MSFT'), 'member_ids', (select jsonb_agg(id) from (select id from ids union all select id from old) x),
  'canonical_id', (select id from ids where yahoo_symbol = 'MSF.DE'), 'roles', '{}'::jsonb)));
select is((select status from companies where id = (select company_id from old)), 'inactive', 'a referenced orphan company is kept but marked inactive');
select is((select count(*)::int from universe_snapshots), 1, 'the old snapshot row is untouched');
select is(app.apply_identity_groups('[]'::jsonb) ->> 'groups', '0', 'an empty group list is a no-op');

select * from finish();
rollback;
