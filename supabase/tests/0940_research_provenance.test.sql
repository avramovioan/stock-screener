-- Research provenance and wait reasons (migration 20261015007900): the report columns, their checks, and the public feed and
-- card-research view that carry them to the cards. 23 assertions.
begin;
create extension if not exists pgtap with schema extensions;
truncate public.todays_discounts, public.signal_episodes, public.universe_membership_events, public.universe_snapshots, public.scan_security_results, public.scan_events, public.scan_jobs, public.market_cap_snapshots, public.scan_runs restart identity cascade;
select plan(23);

-- columns ------------------------------------------------------------------------------------------------------------
select has_column('public', 'research_reports', 'fallback_reason', 'research_reports.fallback_reason exists');
select has_column('public', 'research_reports', 'wait_reason', 'research_reports.wait_reason exists');
select has_column('public', 'research_reports', 'last_attempt_at', 'research_reports.last_attempt_at exists');
select has_column('public', 'research_reports', 'next_attempt_at', 'research_reports.next_attempt_at exists');
select has_column('public', 'research_reports', 'next_provider', 'research_reports.next_provider exists');
select ok((select bool_and(not is_nullable::boolean) is not true
             from (select (c.is_nullable = 'YES') as is_nullable
                     from information_schema.columns c
                    where c.table_schema = 'public' and c.table_name = 'research_reports'
                      and c.column_name in ('fallback_reason', 'wait_reason', 'last_attempt_at', 'next_attempt_at', 'next_provider')) x),
          'all five new columns are nullable (they apply cleanly on top of existing rows)');

-- fixtures ------------------------------------------------------------------------------------------------------------
create function pg_temp.uid(p_kind int, p_i int) returns uuid language sql immutable as $$
  select ('00000000-0000-0000-' || lpad(p_kind::text, 4, '0') || '-' || lpad(p_i::text, 12, '0'))::uuid
$$;
insert into companies (id, name, name_normalized) select pg_temp.uid(1, i), 'Company ' || i, 'company ' || i from generate_series(1, 4) i;
insert into securities (id, company_id, yahoo_symbol, exchange_code, currency, currency_major, quote_type, is_canonical)
select pg_temp.uid(2, i), pg_temp.uid(1, i), 'S' || i, 'NMS', 'USD', 'USD', 'EQUITY', true from generate_series(1, 4) i;
insert into scan_runs (id, scan_date_local, status, settings_snapshot, started_at, finished_at, results_published_at, list_published_at)
values (pg_temp.uid(3, 1), '2026-10-14', 'complete', '{}', '2026-10-14 07:00+00', '2026-10-14 07:40+00', '2026-10-14 07:40+00', '2026-10-14 07:40+00');
insert into signal_episodes (id, security_id, company_id, kind, mode, threshold_line, opened_scan_run_id, opened_session_date, opened_close, opened_line_value, open_reason, last_evaluated_session_date)
select pg_temp.uid(4, i), pg_temp.uid(2, i), pg_temp.uid(1, i), 'discount', 'worldwide', '-3', pg_temp.uid(3, 1), '2026-10-13', 9, 10, 'new_entry', '2026-10-13' from generate_series(1, 4) i;

-- 1: written by the backup model after an overload; 2: waiting for the weekend; 3: complete, untouched columns (an old row); 4: holders-only
insert into research_reports (id, security_id, company_id, trigger, status, visibility, idempotency_key, provider, model, fallback_reason, completed_at)
values (pg_temp.uid(5, 1), pg_temp.uid(2, 1), pg_temp.uid(1, 1), 'new_discount', 'complete', 'public', 'k1', 'mistral', 'mistral-large-latest', 'primary_unavailable', '2026-10-14 08:00+00');
insert into research_reports (id, security_id, company_id, trigger, status, visibility, idempotency_key, wait_reason, last_attempt_at, next_attempt_at, next_provider, provider, model)
values (pg_temp.uid(5, 2), pg_temp.uid(2, 2), pg_temp.uid(1, 2), 'new_discount', 'queued', 'public', 'k2', 'weekend', '2026-10-14 08:00+00', '2026-10-19 07:00+00', 'gemini-3.5-flash', null, null);
insert into research_reports (id, security_id, company_id, trigger, status, visibility, idempotency_key, provider, model, completed_at)
values (pg_temp.uid(5, 3), pg_temp.uid(2, 3), pg_temp.uid(1, 3), 'new_discount', 'complete', 'public', 'k3', 'gemini', 'gemini-3.5-flash', '2026-10-14 08:00+00');
insert into research_reports (id, security_id, company_id, trigger, status, visibility, idempotency_key, provider, model, fallback_reason, wait_reason, next_provider)
values (pg_temp.uid(5, 4), pg_temp.uid(2, 4), pg_temp.uid(1, 4), 'monitor_first', 'queued', 'holders', 'k4', 'gemini', 'gemini-3.5-flash', 'primary_quota', 'llm_quota', 'gemini-3.5-flash');

insert into todays_discounts (scan_run_id, mode, security_id, company_id, episode_id, is_new_episode, rank, close, currency, session_date, threshold_line, lower_line_end, channel, trend_ok, eligibility,
                              operational_category, category_reason, data_freshness, display_order, withheld, research_report_id, report_id, research_completed_at) values
  (pg_temp.uid(3, 1), 'worldwide', pg_temp.uid(2, 1), pg_temp.uid(1, 1), pg_temp.uid(4, 1), true, 1, 9, 'USD', '2026-10-13', '-3', 10, '{}', true, '{}', 'green',   'meets_checks',     'fresh', 1, false, pg_temp.uid(5, 1), pg_temp.uid(5, 1), '2026-10-14 08:00+00'),
  (pg_temp.uid(3, 1), 'worldwide', pg_temp.uid(2, 2), pg_temp.uid(1, 2), pg_temp.uid(4, 2), true, 2, 9, 'USD', '2026-10-13', '-3', 10, '{}', true, '{}', 'pending', 'research_pending',  'fresh', 2, true,  pg_temp.uid(5, 2), pg_temp.uid(5, 2), null),
  (pg_temp.uid(3, 1), 'worldwide', pg_temp.uid(2, 3), pg_temp.uid(1, 3), pg_temp.uid(4, 3), true, 3, 9, 'USD', '2026-10-13', '-3', 10, '{}', true, '{}', 'green',   'meets_checks',     'fresh', 3, false, pg_temp.uid(5, 3), pg_temp.uid(5, 3), '2026-10-14 08:00+00'),
  (pg_temp.uid(3, 1), 'worldwide', pg_temp.uid(2, 4), pg_temp.uid(1, 4), pg_temp.uid(4, 4), true, 4, 9, 'USD', '2026-10-13', '-3', 10, '{}', true, '{}', 'pending', 'research_pending',  'fresh', 4, true,  pg_temp.uid(5, 4), pg_temp.uid(5, 4), null);

-- the feed ------------------------------------------------------------------------------------------------------------
select has_column('public', 'v_todays_discounts', 'research_provider', 'the feed has research_provider');
select col_type_is('public', 'v_todays_discounts', 'last_attempt_at', 'timestamp with time zone', 'last_attempt_at is a timestamptz');
select col_type_is('public', 'v_todays_discounts', 'wait_reason', 'text', 'wait_reason is text');
select col_type_is('public', 'v_todays_discounts', 'research_completed_at', 'timestamp with time zone', 'research_completed_at is a timestamptz');
set local role anon;
select is((select research_provider || '/' || research_model || '/' || fallback_reason from public.todays_discounts_feed('worldwide') where rank = 1),
          'mistral/mistral-large-latest/primary_unavailable', 'a report written by the backup shows its writer and the fallback reason');
select is((select wait_reason || '/' || next_provider || '/' || last_attempt_at::text || '/' || next_attempt_at::text from public.todays_discounts_feed('worldwide') where rank = 2),
          'weekend/gemini-3.5-flash/2026-10-14 08:00:00+00/2026-10-19 07:00:00+00', 'a waiting report shows reason, next model and both times');
select is((select (research_provider is null and research_model is null)::text from public.todays_discounts_feed('worldwide') where rank = 2),
          'true', 'a waiting report that has not started has no writer yet');
select is((select (fallback_reason is null and wait_reason is null and last_attempt_at is null and next_attempt_at is null and next_provider is null)::text
             from public.todays_discounts_feed('worldwide') where rank = 3),
          'true', 'an existing report keeps null reasons and its stored provider and model');
select is((select research_provider || '/' || research_model from public.todays_discounts_feed('worldwide') where rank = 3),
          'gemini/gemini-3.5-flash', 'and its provider and model stay as stored');
select is((select (research_provider is null and fallback_reason is null and wait_reason is null and next_provider is null)::text
             from public.todays_discounts_feed('worldwide') where rank = 4),
          'true', 'a holders-only report is invisible to anon: no provenance leaks through the join');
select is((select count(*)::int from public.todays_discounts_feed('worldwide')), 4, 'the join adds no rows');
reset role;

-- the card research view -----------------------------------------------------------------------------------------------
set local role anon;
select is((select research_provider || '/' || research_model || '/' || fallback_reason from public.v_card_research where research_report_id = pg_temp.uid(5, 1)),
          'mistral/mistral-large-latest/primary_unavailable', 'v_card_research carries the same fields');
select is((select wait_reason || '/' || next_provider from public.v_card_research where research_report_id = pg_temp.uid(5, 2)),
          'weekend/gemini-3.5-flash', 'v_card_research carries the wait fields');
select is((select provider || '/' || model from public.v_card_research where research_report_id = pg_temp.uid(5, 1)),
          'mistral/mistral-large-latest', 'the older provider and model columns are still there');
reset role;

-- checks ---------------------------------------------------------------------------------------------------------------
select throws_ok($$update research_reports set fallback_reason = 'because' where id = '00000000-0000-0000-0005-000000000001'$$, '23514', null, 'an unknown fallback_reason is refused');
select throws_ok($$update research_reports set wait_reason = 'tuesday' where id = '00000000-0000-0000-0005-000000000001'$$, '23514', null, 'an unknown wait_reason is refused');
select lives_ok($$update research_reports set wait_reason = 'cadence_72h', fallback_reason = 'primary_rate_limited' where id = '00000000-0000-0000-0005-000000000003'$$, 'the documented values are accepted');

select * from finish();
rollback;
