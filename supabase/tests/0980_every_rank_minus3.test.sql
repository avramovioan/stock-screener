-- A-51 (migration 20261015008500): every rank triggers on the -3 line; the feed carries both line ends, reached_line4 and is_top10;
-- digest candidates carry the tag inputs and include every rank. 19 assertions.
begin;
create extension if not exists pgtap with schema extensions;
truncate public.todays_discounts, public.signal_episodes, public.universe_membership_events, public.universe_snapshots, public.scan_security_results, public.scan_events, public.scan_jobs, public.market_cap_snapshots, public.scan_runs restart identity cascade;
select plan(19);

create function pg_temp.uid(p_kind int, p_i int) returns uuid language sql immutable as $$
  select ('00000000-0000-0000-' || lpad(p_kind::text, 4, '0') || '-' || lpad(p_i::text, 12, '0'))::uuid
$$;

-- columns, in order, appended last ------------------------------------------------------------------------------------
select is((select array_agg(column_name::text order by ordinal_position)
             from (select column_name, ordinal_position from information_schema.columns
                    where table_schema = 'public' and table_name = 'v_todays_discounts' order by ordinal_position desc limit 5 offset 6) c),
          array['evidence_trimmed', 'line3_end', 'line4_end', 'reached_line4', 'is_top10'],
          'evidence_trimmed, line3_end, line4_end, reached_line4, is_top10 stay in that order (migration 20261015008800 appends five more and 20261015009300 one more after them)');
select col_type_is('public', 'v_todays_discounts', 'line3_end', 'double precision', 'line3_end is float8');
select col_type_is('public', 'v_todays_discounts', 'line4_end', 'double precision', 'line4_end is float8');
select col_type_is('public', 'v_todays_discounts', 'reached_line4', 'boolean', 'reached_line4 is boolean');
select col_type_is('public', 'v_todays_discounts', 'is_top10', 'boolean', 'is_top10 is boolean');

-- fixtures: the channel stores both lines (-3 = 90, -4 = 80) ---------------------------------------------------------------
insert into companies (id, name, name_normalized) select pg_temp.uid(1, i), 'Company ' || i, 'company ' || i from generate_series(1, 5) i;
insert into securities (id, company_id, yahoo_symbol, exchange_code, currency, currency_major, quote_type, is_canonical)
select pg_temp.uid(2, i), pg_temp.uid(1, i), 'S' || i, 'NMS', 'USD', 'USD', 'EQUITY', true from generate_series(1, 5) i;
insert into scan_runs (id, scan_date_local, status, settings_snapshot, started_at, finished_at, results_published_at, list_published_at)
values (pg_temp.uid(3, 1), '2026-10-14', 'complete', '{}', '2026-10-14 07:00+00', '2026-10-14 07:40+00', '2026-10-14 07:40+00', '2026-10-14 07:40+00');
insert into signal_episodes (id, security_id, company_id, kind, mode, threshold_line, opened_scan_run_id, opened_session_date, opened_close, opened_line_value, open_reason, last_evaluated_session_date)
select pg_temp.uid(4, i), pg_temp.uid(2, i), pg_temp.uid(1, i), 'discount', 'worldwide', case when i = 5 then '-4' else '-3' end::threshold_line, pg_temp.uid(3, 1), '2026-10-13', 9, 10, 'new_entry', '2026-10-13'
  from generate_series(1, 5) i;
-- rank 4: between the lines (85); rank 10: exactly on the -4 line (80); rank 11: between the lines; rank 40: below -4 (70);
-- rank 41: a legacy episode on -4 with no stored channel ends (lower_line_end = the -4 value 80, close 79)
insert into todays_discounts (scan_run_id, mode, security_id, company_id, episode_id, is_new_episode, rank, close, currency, session_date, threshold_line, lower_line_end, channel, trend_ok, eligibility,
                              operational_category, category_reason, data_freshness, display_order, withheld) values
  (pg_temp.uid(3, 1), 'worldwide', pg_temp.uid(2, 1), pg_temp.uid(1, 1), pg_temp.uid(4, 1), true,  4, 85, 'USD', '2026-10-13', '-3', 90, '{"end":{"lower1":90,"lower2":80}}', true, '{}', 'green', 'meets_checks', 'fresh',  4, false),
  (pg_temp.uid(3, 1), 'worldwide', pg_temp.uid(2, 2), pg_temp.uid(1, 2), pg_temp.uid(4, 2), true, 10, 80, 'USD', '2026-10-13', '-3', 90, '{"end":{"lower1":90,"lower2":80}}', true, '{}', 'green', 'meets_checks', 'fresh', 10, false),
  (pg_temp.uid(3, 1), 'worldwide', pg_temp.uid(2, 3), pg_temp.uid(1, 3), pg_temp.uid(4, 3), true, 11, 85, 'USD', '2026-10-13', '-3', 90, '{"end":{"lower1":90,"lower2":80}}', true, '{}', 'green', 'meets_checks', 'fresh', 11, false),
  (pg_temp.uid(3, 1), 'worldwide', pg_temp.uid(2, 4), pg_temp.uid(1, 4), pg_temp.uid(4, 4), true, 40, 70, 'USD', '2026-10-13', '-3', 90, '{"end":{"lower1":90,"lower2":80}}', true, '{}', 'amber', 'meets_checks', 'fresh', 40, false),
  (pg_temp.uid(3, 1), 'worldwide', pg_temp.uid(2, 5), pg_temp.uid(1, 5), pg_temp.uid(4, 5), false, 41, 79, 'USD', '2026-10-13', '-4', 80, '{}', true, '{}', 'green', 'meets_checks', 'fresh', 41, false);

-- the feed derives the values ----------------------------------------------------------------------------------------------
set local role anon;
select is((select line3_end || '/' || line4_end from public.todays_discounts_feed('worldwide') where rank = 4), '90/80', 'both line ends come from the stored channel (rank 4)');
select is((select line3_end || '/' || line4_end from public.todays_discounts_feed('worldwide') where rank = 40), '90/80', 'both line ends come from the stored channel (rank 40)');
select is((select is_top10::text || '/' || reached_line4::text from public.todays_discounts_feed('worldwide') where rank = 4), 'true/false', 'rank 4 between the lines: top 10, -4 not reached');
select is((select is_top10::text || '/' || reached_line4::text from public.todays_discounts_feed('worldwide') where rank = 10), 'true/true', 'rank 10 exactly on the -4 line: top 10 and reached (equality qualifies)');
select is((select is_top10::text || '/' || reached_line4::text from public.todays_discounts_feed('worldwide') where rank = 11), 'false/false', 'rank 11 between the lines is a card: not top 10, waiting for -4');
select is((select is_top10::text || '/' || reached_line4::text from public.todays_discounts_feed('worldwide') where rank = 40), 'false/true', 'rank 40 below -4: not top 10, -4 reached');
select is((select line4_end || '/' || reached_line4::text from public.todays_discounts_feed('worldwide') where rank = 41), '80/true', 'a legacy -4 episode without stored ends falls back to its own line value');
select is((select count(*)::int from public.todays_discounts_feed('worldwide') where threshold_line = '-3'), 4, 'new episodes carry threshold_line -3 whatever the rank');
select is((select count(*)::int from public.v_todays_discounts), 5, 'the new columns add no rows and a rank 11+ card between the lines is listed');
reset role;

-- grants ----------------------------------------------------------------------------------------------------------------------
select ok(has_table_privilege('anon', 'public.v_todays_discounts', 'SELECT') and has_table_privilege('authenticated', 'public.v_todays_discounts', 'SELECT'),
          'anon and authenticated keep select on v_todays_discounts');
select ok(has_function_privilege('anon', 'public.todays_discounts_feed(universe_mode)', 'EXECUTE') and has_function_privilege('authenticated', 'public.todays_discounts_feed(universe_mode)', 'EXECUTE'),
          'anon and authenticated keep execute on todays_discounts_feed');
select ok(not has_function_privilege('anon', 'public.notify_discount_candidates(uuid, uuid, boolean)', 'EXECUTE')
      and not has_function_privilege('authenticated', 'public.notify_discount_candidates(uuid, uuid, boolean)', 'EXECUTE')
      and has_function_privilege('service_role', 'public.notify_discount_candidates(uuid, uuid, boolean)', 'EXECUTE'),
          'notify_discount_candidates stays service role only');

-- digest candidates: every rank, with the tag inputs -------------------------------------------------------------------------
insert into auth.users (id, email, email_confirmed_at, instance_id, aud, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'a1@example.com', now(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');
insert into notification_preferences (user_id, email_enabled) values ('00000000-0000-0000-0000-0000000000a1', true);
select is((select array_agg(rank order by rank) from public.notify_discount_candidates(pg_temp.uid(3, 1), '00000000-0000-0000-0000-0000000000a1', false)),
          array[4, 10, 11, 40, 41], 'the digest offers every discount, rank 11+ included');
select is((select array_agg(is_top10::text || '/' || reached_line4::text order by rank) from public.notify_discount_candidates(pg_temp.uid(3, 1), '00000000-0000-0000-0000-0000000000a1', false)),
          array['true/false', 'true/true', 'false/false', 'false/true', 'false/true'], 'the candidates carry is_top10 and reached_line4 (a legacy -4 episode counts as reached)');

select * from finish();
rollback;
