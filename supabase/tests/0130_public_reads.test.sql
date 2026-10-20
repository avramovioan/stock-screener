begin;
create extension if not exists pgtap with schema extensions;
truncate public.todays_discounts, public.signal_episodes, public.universe_membership_events, public.universe_snapshots, public.scan_security_results, public.scan_events, public.scan_jobs, public.market_cap_snapshots, public.scan_runs restart identity cascade;
select plan(45);

-- fixtures: 40 companies ranked 1..40 in a list-published run ---------------------------------------------------
create function pg_temp.uid(p_kind int, p_i int) returns uuid language sql immutable as $$
  select ('00000000-0000-0000-' || lpad(p_kind::text, 4, '0') || '-' || lpad(p_i::text, 12, '0'))::uuid
$$;

insert into companies (id, name, name_normalized) select pg_temp.uid(1, i), 'Company ' || lpad(i::text, 2, '0'), 'company ' || lpad(i::text, 2, '0') from generate_series(1, 45) i;
insert into securities (id, company_id, yahoo_symbol, exchange_code, currency, currency_major, quote_type, is_canonical)
select pg_temp.uid(2, i), pg_temp.uid(1, i), 'S' || lpad(i::text, 2, '0'), 'NMS', 'USD', 'USD', 'EQUITY', true from generate_series(1, 45) i;

insert into scan_runs (id, scan_date_local, status, settings_snapshot, started_at, finished_at, results_published_at, list_published_at, latest_session_date)
values (pg_temp.uid(3, 1), '2026-10-13', 'complete', '{}', '2026-10-13 07:00+00', '2026-10-13 07:40+00', '2026-10-13 07:40+00', '2026-10-13 07:40+00', '2026-10-12'),
       (pg_temp.uid(3, 2), '2026-10-14', 'partial',  '{}', '2026-10-14 07:00+00', '2026-10-14 07:50+00', '2026-10-14 07:50+00', '2026-10-14 07:50+00', '2026-10-13');

insert into universe_snapshots (scan_run_id, mode, security_id, company_id, rank, market_cap_usd, is_top10, applicable_line, lower_line_end, close, session_date, lower_line_positive, is_discount)
select pg_temp.uid(3, 2), 'worldwide', pg_temp.uid(2, i), pg_temp.uid(1, i), i, (100 - i) * 1e9, i <= 10, case when i <= 10 then '-3' else '-4' end::threshold_line, 10, 12, '2026-10-13', true, false
  from generate_series(1, 40) i;

insert into price_series (security_id, bar_dates, open, high, low, close, volume, bar_count, first_bar_date, last_bar_date, last_session_date, last_close, prev_close, retrieved_at, last_full_refresh_at, freshness)
values (pg_temp.uid(2, 1), '{1,2}', '{1,1}', '{2,2}', '{0,0}', '{1,2}', '{5,5}', 2, '1970-01-02', '1970-01-03', '2026-10-13', 110, 100, now(), now(), 'fresh');
insert into market_cap_snapshots (scan_run_id, security_id, market_cap_native, currency_major, source, quality)
values (pg_temp.uid(3, 2), pg_temp.uid(2, 1), 9.9e10, 'USD', 'yahoo_screener', 'ok');

-- company_list as an anonymous visitor ------------------------------------------------------------------------
set local role anon;
select is((select count(*)::int from company_list('worldwide')), 15, 'the first page has 15 rows');
select is((select array_agg(rank order by rank) from company_list('worldwide')), (select array_agg(i order by i) from generate_series(1, 15) i), 'the first page is ranks 1..15 in order');
select is((select min(total_count) from company_list('worldwide')), 40::bigint, 'total_count is the list size on the first page');
select is((select array_agg(rank order by rank) from company_list('worldwide', 25, 15)), (select array_agg(i order by i) from generate_series(16, 40) i), 'Load more after rank 15 with 25 rows gives ranks 16..40');
select is((select count(*)::int from company_list('worldwide', 25, 40)), 0, 'nothing after the last rank');
select is((select min(total_count) from company_list('worldwide', 25, 15)), 25::bigint, 'total_count counts the rows after the cursor');
select is((select count(*)::int from company_list('worldwide', 1000)), 40, 'a page is clamped to 100 rows, so 40 rows come back');
select is((select count(*)::int from company_list('worldwide', 0)), 1, 'a limit of 0 is raised to 1');
select is((select count(*)::int from (select rank from company_list('worldwide') union select rank from company_list('worldwide', 25, 15)) u), 40, 'two pages are complete and disjoint');
select is((select count(*)::int from company_list('us')), 0, 'the us mode has no rows here');
select is((select is_top10::text || ':' || applicable_line::text from company_list('worldwide', 1, 9)), 'true:-3', 'rank 10 is top 10 with the -3 line');
select is((select is_top10::text || ':' || applicable_line::text from company_list('worldwide', 1, 10)), 'false:-4', 'rank 11 is not top 10 and uses the -4 line');
select is((select round(change_pct::numeric, 6) from company_list('worldwide', 1)), 10.000000, 'change_pct is last close vs previous close');
select is((select market_cap_native::text || ' ' || market_cap_ccy from company_list('worldwide', 1)), '99000000000 USD', 'native market cap and currency come from the latest snapshot');
select is((select yahoo_symbol || ' ' || name from company_list('worldwide', 1)), 'S01 Company 01', 'symbol and name are joined');
select is((select count(*)::int from company_list('worldwide', 1) where last_close is not null), 1, 'last_close is read without array access');
reset role;

-- the latest LIST-PUBLISHED run wins; an unpublished newer run is ignored
insert into scan_runs (id, scan_date_local, status, settings_snapshot, started_at, results_published_at, list_published_at)
values (pg_temp.uid(3, 3), '2026-10-15', 'running', '{}', '2026-10-15 07:00+00', null, null);
insert into universe_snapshots (scan_run_id, mode, security_id, company_id, rank, market_cap_usd, is_top10, applicable_line)
select pg_temp.uid(3, 3), 'worldwide', pg_temp.uid(2, i), pg_temp.uid(1, i), i, 1, true, '-3' from generate_series(41, 43) i;
set local role anon;
select is((select count(*)::int from company_list('worldwide', 100)), 40, 'an unpublished newer run does not replace the published list');
reset role;
update scan_runs set list_published_at = now(), results_published_at = now() where id = pg_temp.uid(3, 3);
set local role anon;
select is((select count(*)::int from company_list('worldwide', 100)), 3, 'once published, the newest run is the list');
reset role;
update scan_runs set list_published_at = null, results_published_at = null where id = pg_temp.uid(3, 3);

-- universe_summary ----------------------------------------------------------------------------------------
insert into universe_membership_events (scan_run_id, event_date, mode, company_id, security_id, event, reason) values
  (pg_temp.uid(3, 2), '2026-10-14', 'worldwide', pg_temp.uid(1, 41), pg_temp.uid(2, 41), 'added',   'new_listing'),
  (pg_temp.uid(3, 2), '2026-10-14', 'worldwide', pg_temp.uid(1, 42), pg_temp.uid(2, 42), 'removed', 'market_cap_below_threshold'),
  (pg_temp.uid(3, 1), '2026-10-13', 'worldwide', pg_temp.uid(1, 43), pg_temp.uid(2, 43), 'added',   'new_listing'),
  (pg_temp.uid(3, 1), '2026-10-05', 'worldwide', pg_temp.uid(1, 44), pg_temp.uid(2, 44), 'added',   'new_listing'),
  (pg_temp.uid(3, 1), '2026-10-13', 'us',        pg_temp.uid(1, 45), pg_temp.uid(2, 45), 'added',   'new_listing');
set local role anon;
select is(public.universe_summary('worldwide') ->> 'as_of', '2026-10-14', 'the summary is as of the latest list-published run');
select is(public.universe_summary('worldwide') -> 'added_today' -> 0 ->> 'name', 'Company 41', 'added today');
select is(jsonb_array_length(public.universe_summary('worldwide') -> 'added_today'), 1, 'exactly one company added today');
select is(public.universe_summary('worldwide') -> 'removed_today' -> 0 ->> 'name', 'Company 42', 'removed today');
select is((select array_agg(e ->> 'name' order by e ->> 'name') from jsonb_array_elements(public.universe_summary('worldwide') -> 'added_7d') e), array['Company 41', 'Company 43'], 'the trailing 7 days include yesterday and exclude events older than 7 days');
select is(public.universe_summary('worldwide') -> 'added_7d' -> 0 ->> 'date', '2026-10-14', 'added_7d is ordered by most recent date first');
select is(jsonb_array_length(public.universe_summary('us') -> 'added_today'), 0, 'the us summary does not see worldwide events');
select is(public.universe_summary('us') -> 'added_7d' -> 0 ->> 'name', 'Company 45', 'the us summary has its own events');
reset role;

-- scan_status: three separate timestamps ----------------------------------------------------------------------
set local role anon;
select is(public.scan_status() -> 'last_attempted' ->> 'scan_date_local', '2026-10-15', 'last attempted is the newest run even though it is unpublished and running');
select is(public.scan_status() -> 'last_attempted' ->> 'status', 'running', 'and its status is reported honestly');
select is(public.scan_status() -> 'last_successful' ->> 'scan_date_local', '2026-10-13', 'last successful is the newest COMPLETE run (the partial 10-14 run does not count)');
select is(public.scan_status() -> 'latest_published' ->> 'scan_date_local', '2026-10-14', 'latest published is the newest run with published results');
select is(public.scan_status() -> 'latest_published' ->> 'latest_session_date', '2026-10-13', 'with the latest trading session date it represents');
reset role;

-- get_price_series: arrays only through the function ------------------------------------------------------------
set local role anon;
select throws_ok('select bar_dates from price_series', '42501', null, 'the arrays are not directly selectable');
select is((select bar_dates from public.get_price_series(pg_temp.uid(2, 1))), '{1,2}'::int4[], 'get_price_series returns the arrays of one security');
select is((select security_id from public.get_price_series(pg_temp.uid(2, 9))), null, 'an unknown security returns an empty (all-null) row');
reset role;

-- todays_discounts_feed ordering --------------------------------------------------------------------------------
insert into signal_episodes (id, security_id, company_id, kind, mode, threshold_line, opened_scan_run_id, opened_session_date, opened_close, opened_line_value, open_reason, last_evaluated_session_date)
select pg_temp.uid(4, i), pg_temp.uid(2, i), pg_temp.uid(1, i), 'discount', 'worldwide', '-3', pg_temp.uid(3, 2), '2026-10-13', 9, 10, 'new_entry', '2026-10-13' from generate_series(1, 5) i;
insert into todays_discounts (scan_run_id, mode, security_id, company_id, episode_id, is_new_episode, rank, close, currency, session_date, threshold_line, lower_line_end, channel, trend_ok, eligibility,
                              operational_category, category_reason, data_freshness, display_order, withheld) values
  (pg_temp.uid(3, 2), 'worldwide', pg_temp.uid(2, 1), pg_temp.uid(1, 1), pg_temp.uid(4, 1), true, 1, 9, 'USD', '2026-10-13', '-3', 10, '{}', true, '{}', 'grey',  'inconclusive',  'fresh', 1, true),
  (pg_temp.uid(3, 2), 'worldwide', pg_temp.uid(2, 2), pg_temp.uid(1, 2), pg_temp.uid(4, 2), true, 2, 9, 'USD', '2026-10-13', '-3', 10, '{}', true, '{}', 'green', 'meets_checks', 'fresh', 5, false),
  (pg_temp.uid(3, 2), 'worldwide', pg_temp.uid(2, 3), pg_temp.uid(1, 3), pg_temp.uid(4, 3), true, 3, 9, 'USD', '2026-10-13', '-3', 10, '{}', true, '{}', 'amber', 'moderate_risk', 'fresh', 1, false),
  (pg_temp.uid(3, 2), 'worldwide', pg_temp.uid(2, 4), pg_temp.uid(1, 4), pg_temp.uid(4, 4), true, 4, 9, 'USD', '2026-10-13', '-3', 10, '{}', true, '{}', 'green', 'meets_checks', 'fresh', 2, false),
  (pg_temp.uid(3, 2), 'us',        pg_temp.uid(2, 5), pg_temp.uid(1, 5), pg_temp.uid(4, 5), true, 1, 9, 'USD', '2026-10-13', '-3', 10, '{}', true, '{}', 'pending', 'research_pending', 'fresh', 1, true);
set local role anon;
select is((select array_agg(rank order by ord) from (select rank, row_number() over () as ord from public.todays_discounts_feed('worldwide')) f), array[4, 2, 3, 1], 'the feed lists cleared green, then amber, then withheld, by display_order');
select is((select count(*)::int from public.todays_discounts_feed('us')), 1, 'the feed is per mode');
select is((select since_date from public.v_todays_discounts where rank = 2 and mode = 'worldwide'), '2026-10-13'::date, 'since_date comes from the episode');
reset role;

-- purge_expired ------------------------------------------------------------------------------------------------
insert into scan_events (at, level, event) values (now() - interval '31 days', 'info', 'old'), (now() - interval '29 days', 'info', 'recent');
insert into scan_jobs (scan_run_id, stage, key, status, created_at) values
  (pg_temp.uid(3, 1), 'fx', 'old-done', 'done', now() - interval '31 days'),
  (pg_temp.uid(3, 1), 'fx', 'old-dead', 'dead', now() - interval '40 days'),
  (pg_temp.uid(3, 1), 'fx', 'old-queued', 'queued', now() - interval '40 days'),
  (pg_temp.uid(3, 1), 'fx', 'new-done', 'done', now() - interval '2 days');
delete from quote_cache;
insert into quote_cache (key, payload, fetched_at, expires_at) values
  ('expired', '{}', now() - interval '2 hours', now() - interval '1 hour'),
  ('stale-but-unexpired', '{}', now() - interval '2 days', now() + interval '1 day'),
  ('fresh', '{}', now(), now() + interval '1 hour');
insert into universe_membership_events (scan_run_id, event_date, mode, company_id, event, reason) values
  (pg_temp.uid(3, 1), (now() at time zone 'Europe/Sofia')::date - 91, 'us', pg_temp.uid(1, 10), 'added', 'new_listing'),
  (pg_temp.uid(3, 1), (now() at time zone 'Europe/Sofia')::date - 5,  'us', pg_temp.uid(1, 11), 'added', 'new_listing');
select is(app.purge_expired(), '{"scan_events":1,"scan_jobs":2,"quote_cache":2,"universe_membership_events":1}'::jsonb, 'purge_expired reports what it deleted');
select is((select count(*)::int from scan_events where event in ('old', 'recent')), 1, 'only the recent event survives');
select is((select array_agg(key order by key) from scan_jobs where key like 'old-%' or key like 'new-%'), array['new-done', 'old-queued'], 'old terminal jobs are purged; a queued job is never purged');
select is((select array_agg(key order by key) from quote_cache), array['fresh'], 'expired and day-old cache rows are purged');
select is((select count(*)::int from universe_membership_events where event_date < (now() at time zone 'Europe/Sofia')::date - 30), 0, 'membership events older than 90 days are gone');
select is(app.purge_expired(), '{"scan_events":0,"scan_jobs":0,"quote_cache":0,"universe_membership_events":0}'::jsonb, 'a second purge is a no-op (idempotent)');
select is((select count(*)::int from signal_episodes), 5, 'purging never touches signal episodes');
select is((select count(*)::int from todays_discounts), 5, 'purging never touches todays_discounts');

select * from finish();
rollback;
