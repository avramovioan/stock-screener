-- Migration 20261015008800: the Listed-in filter uses the exchange's country, the feed carries listing_country and the research
-- state of the security's newest in-flight and newest failed report, and the research settings hold the visitor scan limits.
begin;
create extension if not exists pgtap with schema extensions;
truncate public.todays_discounts, public.signal_episodes, public.universe_membership_events, public.universe_snapshots, public.scan_security_results, public.scan_events, public.scan_jobs, public.market_cap_snapshots, public.scan_runs restart identity cascade;
select plan(16);

create function pg_temp.uid(p_kind int, p_i int) returns uuid language sql immutable as $$
  select ('00000000-0000-0000-' || lpad(p_kind::text, 4, '0') || '-' || lpad(p_i::text, 12, '0'))::uuid
$$;

-- 1: Irish-domiciled, canonical listing on NYQ; 2: US-domiciled, canonical listing on LSE; 3: US-domiciled on NMS (running report);
-- 4: US-domiciled on NMS (two failed reports, then a queued one)
insert into companies (id, name, name_normalized, country) values
  (pg_temp.uid(1, 1), 'Irish Plc', 'irish plc', 'Ireland'),
  (pg_temp.uid(1, 2), 'American Abroad', 'american abroad', 'United States'),
  (pg_temp.uid(1, 3), 'American One', 'american one', 'United States'),
  (pg_temp.uid(1, 4), 'American Two', 'american two', 'United States');
insert into securities (id, company_id, yahoo_symbol, exchange_code, currency, currency_major, quote_type, is_canonical) values
  (pg_temp.uid(2, 1), pg_temp.uid(1, 1), 'IRL', 'NYQ', 'USD', 'USD', 'EQUITY', true),
  (pg_temp.uid(2, 2), pg_temp.uid(1, 2), 'ABR.L', 'LSE', 'GBp', 'GBP', 'EQUITY', true),
  (pg_temp.uid(2, 3), pg_temp.uid(1, 3), 'AM1', 'NMS', 'USD', 'USD', 'EQUITY', true),
  (pg_temp.uid(2, 4), pg_temp.uid(1, 4), 'AM2', 'NMS', 'USD', 'USD', 'EQUITY', true);
insert into scan_runs (id, scan_date_local, status, settings_snapshot, started_at, finished_at, results_published_at, list_published_at)
values (pg_temp.uid(3, 1), '2026-10-14', 'complete', '{}', '2026-10-14 07:00+00', '2026-10-14 07:40+00', '2026-10-14 07:40+00', '2026-10-14 07:40+00');
insert into universe_snapshots (scan_run_id, mode, security_id, company_id, rank, market_cap_usd, is_top10, applicable_line, lower_line_end, close, session_date, lower_line_positive, is_discount)
select pg_temp.uid(3, 1), 'worldwide', pg_temp.uid(2, i), pg_temp.uid(1, i), i, (100 - i) * 1e9, true, '-3', 10, 12, '2026-10-13', true, true
  from generate_series(1, 4) i;
insert into signal_episodes (id, security_id, company_id, kind, mode, threshold_line, opened_scan_run_id, opened_session_date, opened_close, opened_line_value, open_reason, last_evaluated_session_date)
select pg_temp.uid(4, i), pg_temp.uid(2, i), pg_temp.uid(1, i), 'discount', 'worldwide', '-3', pg_temp.uid(3, 1), '2026-10-13', 9, 10, 'new_entry', '2026-10-13' from generate_series(1, 4) i;
insert into todays_discounts (scan_run_id, mode, security_id, company_id, episode_id, is_new_episode, rank, close, currency, session_date, threshold_line, lower_line_end, channel, trend_ok, eligibility,
                              operational_category, category_reason, data_freshness, display_order, withheld)
select pg_temp.uid(3, 1), 'worldwide', pg_temp.uid(2, i), pg_temp.uid(1, i), pg_temp.uid(4, i), true, i, 85, 'USD', '2026-10-13', '-3', 90, '{"end":{"lower1":90,"lower2":80}}', true, '{}', 'pending', 'research_pending', 'fresh', i, false
  from generate_series(1, 4) i;

-- 3: a running report started by a visitor and waiting on the provider
insert into research_reports (id, security_id, company_id, trigger, status, visibility, idempotency_key, started_at, wait_reason, usage)
values (pg_temp.uid(5, 3), pg_temp.uid(2, 3), pg_temp.uid(1, 3), 'manual', 'running', 'public', 'k3', '2026-10-14 08:05+00', 'rate_limited', '{"source": "visitor"}');
-- 4: an older failed report, a newer failed one, and a queued one by the owner
insert into research_reports (id, security_id, company_id, trigger, status, visibility, idempotency_key, completed_at) values
  (pg_temp.uid(5, 41), pg_temp.uid(2, 4), pg_temp.uid(1, 4), 'manual', 'failed', 'public', 'k41', '2026-10-14 06:00+00'),
  (pg_temp.uid(5, 42), pg_temp.uid(2, 4), pg_temp.uid(1, 4), 'manual', 'failed', 'public', 'k42', '2026-10-14 07:00+00');
insert into research_reports (id, security_id, company_id, trigger, status, visibility, idempotency_key, usage)
values (pg_temp.uid(5, 43), pg_temp.uid(2, 4), pg_temp.uid(1, 4), 'manual', 'queued', 'public', 'k43', '{"source": "owner"}');

-- Listed in: the exchange's country decides -------------------------------------------------------------------------------------
set local role anon;
select is((select array_agg(yahoo_symbol order by rank) from company_list('worldwide', 15, null, 'United States')), array['IRL', 'AM1', 'AM2'],
          'p_country = United States returns the Irish-domiciled company listed on NYQ and excludes the US company listed on LSE');
select is((select array_agg(yahoo_symbol order by rank) from company_list('worldwide', 15, null, 'United Kingdom')), array['ABR.L'], 'United Kingdom matches the exchange country (LSE)');
select is((select count(*)::int from company_list('worldwide', 15, null, null)), 4, 'no country keeps the unfiltered list');
select is((select country || '/' || listing_country from company_list('worldwide', 15, null, null) where yahoo_symbol = 'IRL'), 'Ireland/United States',
          'country stays the home country and listing_country is the exchange country (Irish company on NYQ)');
select is((select country || '/' || listing_country from company_list('worldwide', 15, null, null) where yahoo_symbol = 'ABR.L'), 'United States/United Kingdom',
          'country stays the home country and listing_country is the exchange country (US company on LSE)');

-- The feed ----------------------------------------------------------------------------------------------------------------------
select is((select listing_country from todays_discounts_feed('worldwide') where yahoo_symbol = 'IRL'), 'United States', 'the feed carries listing_country (the exchange country)');
select is((select country from todays_discounts_feed('worldwide') where yahoo_symbol = 'IRL'), 'Ireland', 'the feed keeps the home country in country');
select is((select (research_started_at is null and research_wait_reason is null and research_requested_by is null and research_failed_at is null)::text
             from todays_discounts_feed('worldwide') where yahoo_symbol = 'IRL'), 'true', 'no report: the four research columns are null');
select is((select research_started_at from todays_discounts_feed('worldwide') where yahoo_symbol = 'AM1'), '2026-10-14 08:05+00'::timestamptz, 'a running report fills research_started_at');
select is((select research_wait_reason from todays_discounts_feed('worldwide') where yahoo_symbol = 'AM1'), 'rate_limited', 'a running report fills research_wait_reason');
select is((select research_requested_by from todays_discounts_feed('worldwide') where yahoo_symbol = 'AM1'), 'visitor', 'research_requested_by is usage.source');
select is((select research_requested_by from todays_discounts_feed('worldwide') where yahoo_symbol = 'AM2'), 'owner', 'a queued report counts as in flight (requested by the owner)');
select is((select research_failed_at from todays_discounts_feed('worldwide') where yahoo_symbol = 'AM2'), '2026-10-14 07:00+00'::timestamptz, 'research_failed_at is the newest failed report');
select is((select research_failed_at from todays_discounts_feed('worldwide') where yahoo_symbol = 'AM1'), null, 'no failed report: research_failed_at is null');
reset role;

-- Settings ----------------------------------------------------------------------------------------------------------------------
select is((select (value ->> 'visitor_scans_per_hour_per_ip') || '/' || (value ->> 'visitor_scans_per_day') || '/' || (value ->> 'visitor_retry_minutes')
             from app_settings where key = 'research'), '3/8/60', 'the research settings hold the visitor scan limits');
select is((select (value ->> 'tavily_daily_cap')::int from app_settings where key = 'research'), 60, 'tavily_daily_cap is 60');

select * from finish();
rollback;
