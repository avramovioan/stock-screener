-- Migration 20261015009300: the provider chain settings, the model quota state, research_quota_status(), the feed's
-- research_failed_reason and the one-time reset of unfinished research.
begin;
create extension if not exists pgtap with schema extensions;
truncate public.todays_discounts, public.signal_episodes, public.universe_membership_events, public.universe_snapshots, public.scan_security_results, public.scan_events, public.scan_jobs, public.market_cap_snapshots, public.scan_runs restart identity cascade;
delete from public.llm_model_state;
delete from public.ai_quota_usage;
select plan(21);

create function pg_temp.uid(p_kind int, p_i int) returns uuid language sql immutable as $$
  select ('00000000-0000-0000-' || lpad(p_kind::text, 4, '0') || '-' || lpad(p_i::text, 12, '0'))::uuid
$$;

-- 1: a quota-deferred report with an open job; 2: a complete report (must survive the reset); 3: a failed no_quota report;
-- 4: an old in-flight report followed by a newer complete one
insert into companies (id, name, name_normalized, country) values
  (pg_temp.uid(1, 1), 'Deferred Inc', 'deferred inc', 'United States'),
  (pg_temp.uid(1, 2), 'Complete Inc', 'complete inc', 'United States'),
  (pg_temp.uid(1, 3), 'Nocota Inc', 'nocota inc', 'United States'),
  (pg_temp.uid(1, 4), 'Superseded Inc', 'superseded inc', 'United States');
insert into securities (id, company_id, yahoo_symbol, exchange_code, currency, currency_major, quote_type, is_canonical) values
  (pg_temp.uid(2, 1), pg_temp.uid(1, 1), 'DEF', 'NMS', 'USD', 'USD', 'EQUITY', true),
  (pg_temp.uid(2, 2), pg_temp.uid(1, 2), 'CMP', 'NMS', 'USD', 'USD', 'EQUITY', true),
  (pg_temp.uid(2, 3), pg_temp.uid(1, 3), 'NOQ', 'NMS', 'USD', 'USD', 'EQUITY', true),
  (pg_temp.uid(2, 4), pg_temp.uid(1, 4), 'SUP', 'NMS', 'USD', 'USD', 'EQUITY', true);
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

insert into research_reports (id, security_id, company_id, trigger, status, visibility, idempotency_key, started_at, wait_reason, usage) values
  (pg_temp.uid(5, 1), pg_temp.uid(2, 1), pg_temp.uid(1, 1), 'visitor', 'quota_deferred', 'public', 'k1', '2026-10-14 08:05+00', 'rate_limited', '{"source": "visitor"}');
insert into research_reports (id, security_id, company_id, trigger, status, visibility, idempotency_key, completed_at) values
  (pg_temp.uid(5, 2), pg_temp.uid(2, 2), pg_temp.uid(1, 2), 'manual', 'complete', 'public', 'k2', '2026-10-14 06:00+00'),
  (pg_temp.uid(5, 3), pg_temp.uid(2, 3), pg_temp.uid(1, 3), 'visitor', 'failed', 'public', 'k3', '2026-10-14 07:00+00');
update research_reports set error = 'no_quota' where id = pg_temp.uid(5, 3);
insert into research_reports (id, security_id, company_id, trigger, status, visibility, idempotency_key, started_at, completed_at, usage) values
  (pg_temp.uid(5, 41), pg_temp.uid(2, 4), pg_temp.uid(1, 4), 'visitor', 'running', 'public', 'k41', '2026-10-14 05:00+00', null, '{"source": "visitor"}'),
  (pg_temp.uid(5, 42), pg_temp.uid(2, 4), pg_temp.uid(1, 4), 'manual', 'complete', 'public', 'k42', '2026-10-14 05:30+00', '2026-10-14 06:30+00', '{}');
insert into scan_jobs (scan_run_id, stage, key, status, payload) values
  (pg_temp.uid(3, 1), 'research', 'research:def:visitor', 'queued', jsonb_build_object('security_id', pg_temp.uid(2, 1), 'trigger', 'visitor')),
  (pg_temp.uid(3, 1), 'research', 'research:cmp:manual', 'queued', jsonb_build_object('security_id', pg_temp.uid(2, 2), 'trigger', 'manual'));

-- The one-time reset (the statement of the migration, run on the rows above) -------------------------------------------------------
with reset as (
  update public.research_reports set status = 'failed', error = 'reset', completed_at = now()
   where status in ('queued', 'running', 'quota_deferred') returning id, security_id
)
delete from public.scan_jobs j using reset r
 where j.stage = 'research' and j.status in ('queued', 'leased', 'failed')
   and (j.payload ->> 'report_id' = r.id::text or j.payload ->> 'security_id' = r.security_id::text);

select is((select status::text || '/' || error from research_reports where id = pg_temp.uid(5, 1)), 'failed/reset', 'the reset turns a quota_deferred report into failed with error reset');
select is((select status::text from research_reports where id = pg_temp.uid(5, 2)), 'complete', 'the reset leaves a complete report untouched');
select is((select count(*)::int from scan_jobs where key = 'research:def:visitor'), 0, 'the reset deletes the open research job of a reset report');
select is((select count(*)::int from scan_jobs where key = 'research:cmp:manual'), 1, 'the reset keeps the job of a security with no unfinished report');
select is((select status::text || '/' || error from research_reports where id = pg_temp.uid(5, 41)), 'failed/reset', 'a running report is reset too');

-- The feed ----------------------------------------------------------------------------------------------------------------------
set local role anon;
select is((select (research_started_at is null and research_wait_reason is null and research_requested_by is null)::text
             from todays_discounts_feed('worldwide') where yahoo_symbol = 'DEF'), 'true', 'a reset report shows no in-flight columns');
select is((select (research_failed_at is null and research_failed_reason is null)::text
             from todays_discounts_feed('worldwide') where yahoo_symbol = 'DEF'), 'true', 'a reset report shows no failed columns');
select is((select research_failed_reason from todays_discounts_feed('worldwide') where yahoo_symbol = 'NOQ'), 'no_quota', 'research_failed_reason is the newest failed report error');
reset role;

-- a newer complete report hides an older in-flight one (set the old one back to running to test the lateral)
update research_reports set status = 'running', error = null, completed_at = null where id = pg_temp.uid(5, 41);
set local role anon;
select is((select research_started_at from todays_discounts_feed('worldwide') where yahoo_symbol = 'SUP'), null, 'a newer complete report hides an older in-flight report');
reset role;
insert into research_reports (id, security_id, company_id, trigger, status, visibility, idempotency_key, started_at, usage)
values (pg_temp.uid(5, 43), pg_temp.uid(2, 4), pg_temp.uid(1, 4), 'visitor', 'running', 'public', 'k43', '2026-10-14 09:00+00', '{"source": "visitor"}');
set local role anon;
select is((select research_started_at from todays_discounts_feed('worldwide') where yahoo_symbol = 'SUP'), '2026-10-14 09:00+00'::timestamptz, 'an in-flight report newer than the complete one shows');
reset role;

-- Settings ----------------------------------------------------------------------------------------------------------------------
select is((select jsonb_array_length(value -> 'llm_chain') from app_settings where key = 'research'), 4, 'the research settings hold a four-model chain');
select is((select string_agg(e ->> 'key', ',') from app_settings, jsonb_array_elements(value -> 'llm_chain') e where key = 'research'),
          'gemini:gemini-3.5-flash,gemini:gemini-3.5-flash-lite,groq:openai/gpt-oss-120b,groq:openai/gpt-oss-20b', 'the chain order is gemini flash, flash-lite, groq 120b, groq 20b');
select is((select (value ->> 'busy_retry_minutes')::int from app_settings where key = 'research'), 15, 'busy_retry_minutes is 15');

-- Quota status ------------------------------------------------------------------------------------------------------------------
set local role anon;
select is((select research_quota_status() ->> 'available'), 'true', 'anon can call research_quota_status; with an empty state table it is available');
select throws_ok($$select * from public.llm_model_state$$, '42501', null, 'anon cannot select llm_model_state');
reset role;
insert into llm_model_state (model_key, exhausted_until) values
  ('gemini:gemini-3.5-flash', now() + interval '3 hours'),
  ('gemini:gemini-3.5-flash-lite', now() + interval '2 hours'),
  ('groq:openai/gpt-oss-120b', now() + interval '5 hours'),
  ('groq:openai/gpt-oss-20b', now() + interval '4 hours');
set local role anon;
select is((select research_quota_status() ->> 'available'), 'false', 'all four keys exhausted: not available');
reset role;
select is((select (research_quota_status() ->> 'next_reset_at')::timestamptz between now() + interval '119 minutes' and now() + interval '121 minutes'), true, 'next_reset_at is the earliest exhausted_until');
update llm_model_state set exhausted_until = now() - interval '1 minute' where model_key = 'groq:openai/gpt-oss-20b';
select is((select research_quota_status() ->> 'available'), 'true', 'one model back in quota makes the status available again');

-- The request ledger: a model whose llm_requests for today reached research.llm_daily_request_cap is out as well
select is((select research_quota_status() ->> 'available'), 'true', 'baseline before the ledger case: available');
insert into ai_quota_usage (provider, resource, period_kind, period_start, used, limit_value)
select k, 'llm_requests', 'day', (now() at time zone 'utc')::date, 300, 300
  from unnest(array['gemini:gemini-3.5-flash', 'gemini:gemini-3.5-flash-lite', 'groq:openai/gpt-oss-120b', 'groq:openai/gpt-oss-20b']) k;
delete from llm_model_state;
select is((select research_quota_status() ->> 'available'), 'false', 'all four keys at the daily request cap: not available');
select is((select (research_quota_status() ->> 'next_reset_at')::timestamptz = (((now() at time zone 'utc')::date + 1)::timestamp at time zone 'utc')),
          true, 'next_reset_at is the next 00:00 UTC when the ledger is the blocker');

select * from finish();
rollback;
