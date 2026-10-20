-- Groq backup (migration 20261015008300): research_reports.evidence_trimmed and the feed and card-research columns that carry it.
-- 11 assertions.
begin;
create extension if not exists pgtap with schema extensions;
truncate public.todays_discounts, public.signal_episodes, public.universe_membership_events, public.universe_snapshots, public.scan_security_results, public.scan_events, public.scan_jobs, public.market_cap_snapshots, public.scan_runs restart identity cascade;
select plan(11);

-- column --------------------------------------------------------------------------------------------------------------
select has_column('public', 'research_reports', 'evidence_trimmed', 'research_reports.evidence_trimmed exists');
select col_type_is('public', 'research_reports', 'evidence_trimmed', 'boolean', 'evidence_trimmed is a boolean');
select col_is_null('public', 'research_reports', 'evidence_trimmed', 'evidence_trimmed is nullable (applies on top of existing rows)');
select col_hasnt_default('public', 'research_reports', 'evidence_trimmed', 'evidence_trimmed has no default (existing rows stay null)');

-- fixtures ------------------------------------------------------------------------------------------------------------
create function pg_temp.uid(p_kind int, p_i int) returns uuid language sql immutable as $$
  select ('00000000-0000-0000-' || lpad(p_kind::text, 4, '0') || '-' || lpad(p_i::text, 12, '0'))::uuid
$$;
insert into companies (id, name, name_normalized) select pg_temp.uid(1, i), 'Company ' || i, 'company ' || i from generate_series(1, 3) i;
insert into securities (id, company_id, yahoo_symbol, exchange_code, currency, currency_major, quote_type, is_canonical)
select pg_temp.uid(2, i), pg_temp.uid(1, i), 'S' || i, 'NMS', 'USD', 'USD', 'EQUITY', true from generate_series(1, 3) i;
insert into scan_runs (id, scan_date_local, status, settings_snapshot, started_at, finished_at, results_published_at, list_published_at)
values (pg_temp.uid(3, 1), '2026-10-14', 'complete', '{}', '2026-10-14 07:00+00', '2026-10-14 07:40+00', '2026-10-14 07:40+00', '2026-10-14 07:40+00');
insert into signal_episodes (id, security_id, company_id, kind, mode, threshold_line, opened_scan_run_id, opened_session_date, opened_close, opened_line_value, open_reason, last_evaluated_session_date)
select pg_temp.uid(4, i), pg_temp.uid(2, i), pg_temp.uid(1, i), 'discount', 'worldwide', '-3', pg_temp.uid(3, 1), '2026-10-13', 9, 10, 'new_entry', '2026-10-13' from generate_series(1, 3) i;

-- 1: written by Groq from a trimmed evidence set; 2: complete, column untouched (an existing row); 3: holders-only, trimmed
insert into research_reports (id, security_id, company_id, trigger, status, visibility, idempotency_key, provider, model, fallback_reason, evidence_trimmed, completed_at)
values (pg_temp.uid(5, 1), pg_temp.uid(2, 1), pg_temp.uid(1, 1), 'new_discount', 'complete', 'public', 'k1', 'groq', 'openai/gpt-oss-120b', 'primary_quota', true, '2026-10-14 08:00+00');
insert into research_reports (id, security_id, company_id, trigger, status, visibility, idempotency_key, provider, model, completed_at)
values (pg_temp.uid(5, 2), pg_temp.uid(2, 2), pg_temp.uid(1, 2), 'new_discount', 'complete', 'public', 'k2', 'gemini', 'gemini-3.5-flash', '2026-10-14 08:00+00');
insert into research_reports (id, security_id, company_id, trigger, status, visibility, idempotency_key, provider, model, fallback_reason, evidence_trimmed)
values (pg_temp.uid(5, 3), pg_temp.uid(2, 3), pg_temp.uid(1, 3), 'monitor_first', 'queued', 'holders', 'k3', 'groq', 'openai/gpt-oss-120b', 'primary_quota', true);

insert into todays_discounts (scan_run_id, mode, security_id, company_id, episode_id, is_new_episode, rank, close, currency, session_date, threshold_line, lower_line_end, channel, trend_ok, eligibility,
                              operational_category, category_reason, data_freshness, display_order, withheld, research_report_id, report_id, research_completed_at) values
  (pg_temp.uid(3, 1), 'worldwide', pg_temp.uid(2, 1), pg_temp.uid(1, 1), pg_temp.uid(4, 1), true, 1, 9, 'USD', '2026-10-13', '-3', 10, '{}', true, '{}', 'green',   'meets_checks',    'fresh', 1, false, pg_temp.uid(5, 1), pg_temp.uid(5, 1), '2026-10-14 08:00+00'),
  (pg_temp.uid(3, 1), 'worldwide', pg_temp.uid(2, 2), pg_temp.uid(1, 2), pg_temp.uid(4, 2), true, 2, 9, 'USD', '2026-10-13', '-3', 10, '{}', true, '{}', 'green',   'meets_checks',    'fresh', 2, false, pg_temp.uid(5, 2), pg_temp.uid(5, 2), '2026-10-14 08:00+00'),
  (pg_temp.uid(3, 1), 'worldwide', pg_temp.uid(2, 3), pg_temp.uid(1, 3), pg_temp.uid(4, 3), true, 3, 9, 'USD', '2026-10-13', '-3', 10, '{}', true, '{}', 'pending', 'research_pending', 'fresh', 3, true,  pg_temp.uid(5, 3), pg_temp.uid(5, 3), null);

-- the feed ------------------------------------------------------------------------------------------------------------
select has_column('public', 'v_todays_discounts', 'evidence_trimmed', 'the feed view has evidence_trimmed');
select is((select column_name::text from information_schema.columns
            where table_schema = 'public' and table_name = 'v_todays_discounts' order by ordinal_position desc limit 1 offset 10),
          'evidence_trimmed', 'evidence_trimmed keeps its place: only the four line/tag columns, the five listing/research columns and research_failed_reason of later migrations follow it');
set local role anon;
select is((select evidence_trimmed::text from public.todays_discounts_feed('worldwide') where rank = 1),
          'true', 'the feed shows a trimmed backup report');
select is((select (evidence_trimmed is null)::text from public.todays_discounts_feed('worldwide') where rank = 2),
          'true', 'an existing report is null, not false');
select is((select (evidence_trimmed is null and research_provider is null)::text from public.todays_discounts_feed('worldwide') where rank = 3),
          'true', 'a holders-only report does not leak through the join');
select is((select count(*)::int from public.todays_discounts_feed('worldwide')), 3, 'the column adds no rows');

-- the card research view ----------------------------------------------------------------------------------------------
select is((select evidence_trimmed::text from public.v_card_research where research_report_id = pg_temp.uid(5, 1)),
          'true', 'v_card_research carries evidence_trimmed');
reset role;

select * from finish();
rollback;
