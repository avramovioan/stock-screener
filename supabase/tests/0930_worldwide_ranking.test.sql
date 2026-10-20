-- Owner decision 2026-10-16 (migrations 20261015007800 and 20261015008100): one worldwide ranking, the US is only a view filter.
-- Digest country filter, country on every public row (company country, exchange country as the fallback), uncapped full reports,
-- scan_cadence scope all.
begin;
create extension if not exists pgtap with schema extensions;
truncate public.todays_discounts, public.signal_episodes, public.universe_membership_events, public.universe_snapshots, public.scan_security_results, public.scan_events, public.scan_jobs, public.market_cap_snapshots, public.scan_runs restart identity cascade;
select plan(34);

-- removed objects ---------------------------------------------------------------------------------------------------
select hasnt_column('public', 'profiles', 'universe_mode', 'profiles has no universe_mode');
select hasnt_function('app', 'research_worldwide_wanted', 'app.research_worldwide_wanted is gone');
select hasnt_function('public', 'research_worldwide_wanted_rpc', 'research_worldwide_wanted_rpc is gone');

-- digest preferences ---------------------------------------------------------------------------------------------------
select col_default_is('public', 'notification_preferences', 'digest_modes', '{worldwide}'::universe_mode[], 'digest_modes defaults to {worldwide}');
select has_column('public', 'notification_preferences', 'digest_country_filter', 'digest_country_filter exists');
select col_type_is('public', 'notification_preferences', 'digest_country_filter', 'text', 'digest_country_filter is text');
select col_is_null('public', 'notification_preferences', 'digest_country_filter', 'digest_country_filter is nullable (null = all countries)');
select ok(has_column_privilege('authenticated', 'public.notification_preferences', 'digest_country_filter', 'SELECT')
      and has_column_privilege('authenticated', 'public.notification_preferences', 'digest_country_filter', 'UPDATE')
      and not has_column_privilege('anon', 'public.notification_preferences', 'digest_country_filter', 'SELECT')
      and not has_column_privilege('anon', 'public.notification_preferences', 'digest_country_filter', 'UPDATE'),
          'the owner reads and updates digest_country_filter, anon holds nothing');

-- the research setting ------------------------------------------------------------------------------------------------
select ok((select value ? 'max_full_reports_per_day' and value -> 'max_full_reports_per_day' = 'null'::jsonb from app_settings where key = 'research'),
          'max_full_reports_per_day is present and null (unlimited)');
select is((select value - 'max_full_reports_per_day' - 'min_recheck_hours' - 'ai_weekdays_only' from app_settings where key = 'research'),
          '{"busy_retry_minutes": 15, "llm_chain": [{"key": "gemini:gemini-3.5-flash", "label": "gemini", "model": "gemini-3.5-flash", "provider": "gemini", "quota_reset": "pacific", "max_input_tokens": null, "reasoning_effort": null, "max_output_tokens": null}, {"key": "gemini:gemini-3.5-flash-lite", "label": "gemini", "model": "gemini-3.5-flash-lite", "provider": "gemini", "quota_reset": "pacific", "max_input_tokens": null, "reasoning_effort": null, "max_output_tokens": null}, {"key": "groq:openai/gpt-oss-120b", "label": "groq", "model": "openai/gpt-oss-120b", "base_url": "https://api.groq.com/openai/v1", "provider": "openai_compatible", "quota_reset": "utc", "max_input_tokens": 4500, "reasoning_effort": "low", "max_output_tokens": 3000}, {"key": "groq:openai/gpt-oss-20b", "label": "groq", "model": "openai/gpt-oss-20b", "base_url": "https://api.groq.com/openai/v1", "provider": "openai_compatible", "quota_reset": "utc", "max_input_tokens": 4500, "reasoning_effort": "low", "max_output_tokens": 3000}], "tavily_daily_cap": 60, "tavily_monthly_budget": 950, "llm_daily_request_cap": 300, "max_change_checks_per_day": 40, "reuse_days": 30, "tavily_reserved_for_reports": 24, "visitor_scans_per_hour_per_ip": 3, "visitor_scans_per_day": 8, "visitor_retry_minutes": 60}'::jsonb,
          'every other research key is kept');
select is((select value ->> 'session_scope' from app_settings where key = 'scan_cadence'), 'all', 'scan_cadence.session_scope defaults to all (the ranking is worldwide)');

-- fixtures: a US company with a country, a German one with a null country (exchange fallback), a Bermuda company on NYSE, a US-exchange one with a null country
insert into auth.users (id, email, email_confirmed_at, instance_id, aud, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'a@example.test', now(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');
insert into companies (id, name, name_normalized, country) values
  ('00000000-0000-0000-0001-000000000001', 'US Co', 'us co', 'United States'),
  ('00000000-0000-0000-0001-000000000002', 'WW Co', 'ww co', null),
  ('00000000-0000-0000-0001-000000000003', 'Bermuda Co', 'bermuda co', 'Bermuda'),
  ('00000000-0000-0000-0001-000000000004', 'US Fallback Co', 'us fallback co', null);
insert into securities (id, company_id, yahoo_symbol, exchange_code, currency, currency_major, quote_type, is_canonical) values
  ('00000000-0000-0000-0002-000000000001', '00000000-0000-0000-0001-000000000001', 'USCO', 'NMS', 'USD', 'USD', 'EQUITY', true),
  ('00000000-0000-0000-0002-000000000002', '00000000-0000-0000-0001-000000000002', 'WWCO', 'GER', 'EUR', 'EUR', 'EQUITY', true),
  ('00000000-0000-0000-0002-000000000003', '00000000-0000-0000-0001-000000000003', 'BMCO', 'NYQ', 'USD', 'USD', 'EQUITY', true),
  ('00000000-0000-0000-0002-000000000004', '00000000-0000-0000-0001-000000000004', 'USFB', 'NYQ', 'USD', 'USD', 'EQUITY', true);
insert into scan_runs (id, scan_date_local, status, settings_snapshot, results_published_at, list_published_at)
values ('00000000-0000-0000-0003-000000000001', '2026-10-16', 'complete', '{}', now(), now());
insert into signal_episodes (id, security_id, company_id, kind, mode, threshold_line, opened_scan_run_id, opened_session_date, opened_close, opened_line_value, open_reason, last_evaluated_session_date)
select ('00000000-0000-0000-0004-00000000000' || n)::uuid, ('00000000-0000-0000-0002-00000000000' || n)::uuid, ('00000000-0000-0000-0001-00000000000' || n)::uuid,
       'discount', 'worldwide', '-3', '00000000-0000-0000-0003-000000000001', '2026-10-15', 9, 10, 'new_entry', '2026-10-15'
  from generate_series(1, 4) n;
insert into todays_discounts (scan_run_id, mode, security_id, company_id, episode_id, is_new_episode, rank, close, currency, session_date, threshold_line, lower_line_end, channel, trend_ok, eligibility, operational_category, category_reason, data_freshness, display_order, withheld)
select '00000000-0000-0000-0003-000000000001', 'worldwide', ('00000000-0000-0000-0002-00000000000' || n)::uuid, ('00000000-0000-0000-0001-00000000000' || n)::uuid,
       ('00000000-0000-0000-0004-00000000000' || n)::uuid, true, n, 9, 'USD', '2026-10-15', '-3', 10, '{}', true, '{}', 'green', 'meets_checks', 'fresh', n, false
  from generate_series(1, 4) n;
insert into universe_snapshots (scan_run_id, mode, security_id, company_id, rank, market_cap_usd, is_top10, applicable_line)
select '00000000-0000-0000-0003-000000000001', 'worldwide', ('00000000-0000-0000-0002-00000000000' || n)::uuid, ('00000000-0000-0000-0001-00000000000' || n)::uuid, n, 1e11, true, '-3'
  from generate_series(1, 4) n;

-- country on the public rows ---------------------------------------------------------------------------------------------
select has_column('public', 'v_todays_discounts', 'country', 'v_todays_discounts has country');
select is((select column_name::text from information_schema.columns where table_schema = 'public' and table_name = 'v_todays_discounts' order by ordinal_position desc limit 1 offset 11),
          'country', 'country keeps its place in the feed view (evidence_trimmed, the four line/tag columns and the five listing/research columns of migration 20261015008800 and research_failed_reason of 20261015009300 are appended after it)');
select is((select country from public.todays_discounts_feed('worldwide') where yahoo_symbol = 'USCO'), 'United States', 'the feed shows the company country');
select is((select country from public.todays_discounts_feed('worldwide') where yahoo_symbol = 'BMCO'), 'Bermuda', 'a company country wins over the exchange country (Bermuda company on NYSE)');
select is((select country from public.todays_discounts_feed('worldwide') where yahoo_symbol = 'WWCO'), 'Germany', 'a null company country falls back to the exchange country');
select is((select country from public.todays_discounts_feed('worldwide') where yahoo_symbol = 'USFB'), 'United States', 'a null company country on a US exchange falls back to United States');
select is((select p.parameter_name::text from information_schema.routines r join information_schema.parameters p on p.specific_name = r.specific_name
            where r.routine_schema = 'public' and r.routine_name = 'company_list' and p.parameter_mode = 'OUT' order by p.ordinal_position desc limit 1 offset 1),
          'country', 'country is the second to last column of company_list (listing_country follows it)');
select is((select country from public.company_list('worldwide', 15) where yahoo_symbol = 'USCO'), 'United States', 'company_list shows the company country');
select is((select country from public.company_list('worldwide', 15) where yahoo_symbol = 'BMCO'), 'Bermuda', 'company_list: company country wins over the exchange');
select is((select country from public.company_list('worldwide', 15) where yahoo_symbol = 'WWCO'), 'Germany', 'company_list: null company country falls back to the exchange');

-- digests: worldwide entries only, filtered by country ------------------------------------------------------------------------
insert into notification_preferences (user_id, email_enabled) values ('00000000-0000-0000-0000-0000000000a1', true);
select is((select coalesce(array_agg(yahoo_symbol order by yahoo_symbol), '{}') from public.notify_discount_candidates('00000000-0000-0000-0003-000000000001', '00000000-0000-0000-0000-0000000000a1', false)),
          array['BMCO', 'USCO', 'USFB', 'WWCO'], 'a null digest_country_filter offers every worldwide candidate');
update notification_preferences set digest_country_filter = 'United States' where user_id = '00000000-0000-0000-0000-0000000000a1';
select is((select coalesce(array_agg(yahoo_symbol order by yahoo_symbol), '{}') from public.notify_discount_candidates('00000000-0000-0000-0003-000000000001', '00000000-0000-0000-0000-0000000000a1', false)),
          array['USCO', 'USFB'], 'the United States filter keeps the US companies, including the exchange fallback');
update notification_preferences set digest_country_filter = 'Japan' where user_id = '00000000-0000-0000-0000-0000000000a1';
select is((select count(*)::int from public.notify_discount_candidates('00000000-0000-0000-0003-000000000001', '00000000-0000-0000-0000-0000000000a1', false)), 0,
          'a filter that matches nothing offers nothing');
update notification_preferences set digest_country_filter = null where user_id = '00000000-0000-0000-0000-0000000000a1';
-- a us-mode card is never offered, even to a user whose digest_modes still lists us
insert into signal_episodes (id, security_id, company_id, kind, mode, threshold_line, opened_scan_run_id, opened_session_date, opened_close, opened_line_value, open_reason, last_evaluated_session_date)
values ('00000000-0000-0000-0004-000000000009', '00000000-0000-0000-0002-000000000001', '00000000-0000-0000-0001-000000000001', 'discount', 'us', '-3', '00000000-0000-0000-0003-000000000001', '2026-10-15', 9, 10, 'new_entry', '2026-10-15');
insert into todays_discounts (scan_run_id, mode, security_id, company_id, episode_id, is_new_episode, rank, close, currency, session_date, threshold_line, lower_line_end, channel, trend_ok, eligibility, operational_category, category_reason, data_freshness, display_order, withheld)
values ('00000000-0000-0000-0003-000000000001', 'us', '00000000-0000-0000-0002-000000000001', '00000000-0000-0000-0001-000000000001', '00000000-0000-0000-0004-000000000009', true, 1, 9, 'USD', '2026-10-15', '-3', 10, '{}', true, '{}', 'green', 'meets_checks', 'fresh', 1, false);
update notification_preferences set digest_modes = '{us,worldwide}' where user_id = '00000000-0000-0000-0000-0000000000a1';
select is((select count(*)::int from public.notify_discount_candidates('00000000-0000-0000-0003-000000000001', '00000000-0000-0000-0000-0000000000a1', false) where mode = 'us'), 0,
          'a us-mode row is never offered to a digest');

-- the country filter of company_list --------------------------------------------------------------------------------------
select is((select count(*)::int from pg_proc where proname = 'company_list' and pronamespace = 'public'::regnamespace), 1, 'company_list has one overload');
select ok(has_function_privilege('anon', 'public.company_list(universe_mode, int, int, text)', 'EXECUTE')
      and has_function_privilege('authenticated', 'public.company_list(universe_mode, int, int, text)', 'EXECUTE'), 'anon and authenticated may execute company_list');
select is((select array_agg(rank order by rank) from public.company_list('worldwide', 15, null, null)), '{1,2,3,4}'::int[], 'a null country keeps the whole list');
select is((select array_agg(rank order by rank) from public.company_list('worldwide', 15, null, 'United States')), '{1,3,4}'::int[], 'United States matches the exchange country (a Bermuda company on NYSE is listed there)');
select is((select array_agg(rank order by rank) from public.company_list('worldwide', 15, null, 'Germany')), '{2}'::int[], 'Germany matches a null company country through its exchange');
select is((select array_agg(rank order by rank) from public.company_list('worldwide', 15, null, 'Bermuda')), null, 'no exchange is in Bermuda: a Bermuda company on NYSE is not listed in Bermuda');
select is((select count(*)::int from public.company_list('worldwide', 15, null, 'Atlantis')), 0, 'an unknown country gives no rows');
select is((select min(total_count) || '/' || count(*) from public.company_list('worldwide', 1, null, 'United States')), '3/1', 'total_count counts the filtered set, not the page');
select is((select rank || ':' || total_count from public.company_list('worldwide', 15, 3, 'United States')), '4:1', 'the rank cursor paginates inside the filtered set');

select * from finish();
rollback;
