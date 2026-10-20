begin;
create extension if not exists pgtap with schema extensions;
truncate public.price_series, public.todays_discounts, public.signal_episodes, public.universe_membership_events, public.universe_snapshots, public.scan_security_results, public.scan_events, public.scan_jobs, public.market_cap_snapshots, public.scan_runs restart identity cascade;
select plan(29);

-- fixtures (inserted as the postgres role) ---------------------------------------------------------------
insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000aa01', 'user-a@example.test'),
                                           ('00000000-0000-0000-0000-00000000aa02', 'user-b@example.test'),
                                           ('00000000-0000-0000-0000-00000000aa03', 'admin@example.test');
insert into profiles (user_id, display_name, is_admin) values ('00000000-0000-0000-0000-00000000aa01', 'A', false),
                                                              ('00000000-0000-0000-0000-00000000aa02', 'B', false),
                                                              ('00000000-0000-0000-0000-00000000aa03', 'Root', true)
  on conflict (user_id) do update set display_name = excluded.display_name, is_admin = excluded.is_admin; -- the P5a trigger pre-creates profiles
insert into companies (id, name, name_normalized) values ('00000000-0000-0000-0000-0000000000c1', 'Acme Corp', 'acme');
insert into securities (id, company_id, yahoo_symbol, exchange_code, currency, currency_major, quote_type, is_canonical)
values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'ACME', 'NMS', 'USD', 'USD', 'EQUITY', true);
insert into price_series (security_id, bar_dates, open, high, low, close, volume, bar_count, first_bar_date, last_bar_date, last_session_date, last_close, retrieved_at, last_full_refresh_at)
values ('00000000-0000-0000-0000-0000000000a1', '{1,2}', '{1,1}', '{2,2}', '{0,0}', '{1,2}', '{5,5}', 2, '1970-01-02', '1970-01-03', '1970-01-03', 2, now(), now());
insert into scan_runs (id, scan_date_local, settings_snapshot, errors_summary, code_version, results_published_at, list_published_at)
values ('00000000-0000-0000-0000-0000000000f1', '2026-10-15', '{"secret":"x"}', '{"e":1}', 'abc', now(), now());
insert into scan_jobs (scan_run_id, stage, key) values ('00000000-0000-0000-0000-0000000000f1', 'fx', 'all');
insert into scan_events (scan_run_id, level, event) values ('00000000-0000-0000-0000-0000000000f1', 'info', 'scan_started');
insert into quote_cache (key, payload, expires_at) values ('yahoo:session', '{"crumb":"x"}', now() + interval '1 hour');
insert into market_cap_snapshots (scan_run_id, security_id, currency_major, source, quality) values ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'USD', 'yahoo_screener', 'ok');
insert into security_identity_overrides (kind, yahoo_symbol, reason) values ('exclude', 'ACME', 'test');
insert into audit_events (action) values ('test');
insert into scan_security_results (scan_run_id, security_id, scope, status, bars_hash) values ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'universe', 'processed', 'h'),
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'holding_only', 'processed', 'h2') on conflict do nothing;
insert into signal_episodes (id, security_id, company_id, kind, mode, threshold_line, opened_scan_run_id, opened_session_date, opened_close, opened_line_value, open_reason, last_evaluated_session_date)
values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'discount', 'worldwide', '-3', '00000000-0000-0000-0000-0000000000f1', '2026-10-14', 99, 100, 'new_entry', '2026-10-14'),
       ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'premium1', 'worldwide', '+1', '00000000-0000-0000-0000-0000000000f1', '2026-10-14', 121, 120, 'new_entry', '2026-10-14');
insert into todays_discounts (scan_run_id, mode, security_id, company_id, episode_id, is_new_episode, rank, close, currency, session_date, threshold_line, lower_line_end, channel, trend_ok,
                              eligibility, operational_category, category_reason, data_freshness, display_order, withheld)
values ('00000000-0000-0000-0000-0000000000f1', 'worldwide', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1', true, 1, 99, 'USD',
        '2026-10-14', '-3', 100, '{}', true, '{}', 'pending', 'research_pending', 'fresh', 1, true);

-- anonymous visitor --------------------------------------------------------------------------------------
set local role anon;
select throws_ok('select * from price_series', '42501', null, 'anon cannot select price_series as a whole');
select throws_ok('select bar_dates from price_series', '42501', null, 'anon cannot read the bar arrays');
select throws_ok('select close from price_series', '42501', null, 'anon cannot read the close array');
select is((select last_close from price_series), 2::float8, 'anon can read the denormalised last_close');
select throws_ok('select * from scan_jobs', '42501', null, 'anon cannot read scan_jobs');
select throws_ok('select * from scan_events', '42501', null, 'anon cannot read scan_events');
select throws_ok('select * from quote_cache', '42501', null, 'anon cannot read quote_cache (session and breaker state)');
select throws_ok('select * from market_cap_snapshots', '42501', null, 'anon cannot read market_cap_snapshots');
select throws_ok('select * from security_identity_overrides', '42501', null, 'anon cannot read identity overrides');
select throws_ok('select * from audit_events', '42501', null, 'anon cannot read audit_events');
select throws_ok('select * from profiles', '42501', null, 'anon cannot read profiles');
select throws_ok('select settings_snapshot from scan_runs', '42501', null, 'anon cannot read scan_runs.settings_snapshot');
select is((select count(*)::int from scan_runs), 1, 'anon can read the public scan_runs columns');
select is((select count(*)::int from app_settings where key = 'pipeline'), 0, 'anon cannot see the non-public pipeline setting');
select is((select count(*)::int from app_settings where key = 'indicator'), 1, 'anon can see the public indicator setting');
select is((select count(*)::int from scan_security_results), 1, 'anon sees universe-scope results only');
select throws_ok('select bars_hash from scan_security_results', '42501', null, 'anon cannot read bars_hash');
select is((select count(*)::int from signal_episodes), 1, 'anon sees discount episodes only (premium episodes would reveal holdings)');
select lives_ok('select * from v_todays_discounts', 'anon can read the public overview view');
select is((select count(*)::int from v_todays_discounts), 1, 'the view returns the published card');
select throws_ok($$update exchanges set name = 'x'$$, '42501', null, 'anon cannot update exchanges');
select throws_ok($$insert into fx_rates (rate_date, ccy, usd_per_unit, source) values ('2026-10-14', 'EUR', 1, 'yahoo')$$, '42501', null, 'anon cannot insert');
select throws_ok('select * from app.claim_jobs(''w'', 1, interval ''1 minute'', array[''fx'']::job_stage[])', '42501', null, 'anon cannot call app functions');
reset role;

-- authenticated, not an admin ------------------------------------------------------------------------------
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000aa01', 'role', 'authenticated')::text, true);
set local role authenticated;
select is((select count(*)::int from profiles), 1, 'user A sees only the own profile row');
select throws_ok($$update profiles set is_admin = true where user_id = '00000000-0000-0000-0000-00000000aa01'$$, '42501', null, 'is_admin is not user-writable');
select throws_ok('select is_admin from profiles', '42501', null, 'is_admin is not selectable');
select is((select count(*)::int from scan_jobs), 0, 'a non-admin sees no scan_jobs rows');
select throws_ok($$update app_settings set value = '{}' where key = 'indicator'$$, '42501', null, 'a non-admin cannot update app_settings');
reset role;

-- admin ---------------------------------------------------------------------------------------------------
select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000aa03', 'role', 'authenticated')::text, true);
set local role authenticated;
select is((select count(*)::int from scan_jobs), 1, 'an admin reads scan_jobs');

select * from finish();
rollback;
