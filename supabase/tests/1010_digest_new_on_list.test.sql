-- Migration 20261015008900: digest candidates are the companies new on the list, whatever their research state. 13 assertions.
begin;
create extension if not exists pgtap with schema extensions;
truncate public.todays_discounts, public.signal_episodes, public.universe_membership_events, public.universe_snapshots, public.scan_security_results, public.scan_events, public.scan_jobs, public.market_cap_snapshots, public.scan_runs restart identity cascade;
select plan(13);

create function pg_temp.uid(p_kind int, p_i int) returns uuid language sql immutable as $$
  select ('00000000-0000-0000-' || lpad(p_kind::text, 4, '0') || '-' || lpad(p_i::text, 12, '0'))::uuid
$$;

-- fixtures: companies 1..6 on NMS (US), 7 on PAR; a previous published run (10-13) and the current one (10-14) -----------------
insert into companies (id, name, name_normalized, country) select pg_temp.uid(1, i), 'Company ' || i, 'company ' || i, case when i = 7 then 'France' else 'United States' end from generate_series(1, 7) i;
insert into securities (id, company_id, yahoo_symbol, exchange_code, currency, currency_major, quote_type, is_canonical)
select pg_temp.uid(2, i), pg_temp.uid(1, i), case when i = 7 then 'RMS.PA' else 'S' || i end, case when i = 7 then 'PAR' else 'NMS' end, 'USD', 'USD', 'EQUITY', true from generate_series(1, 7) i;
insert into scan_runs (id, scan_date_local, status, settings_snapshot, started_at, finished_at, results_published_at, list_published_at) values
  (pg_temp.uid(3, 1), '2026-10-13', 'complete', '{}', '2026-10-13 07:00+00', '2026-10-13 07:40+00', '2026-10-13 07:40+00', '2026-10-13 07:40+00'),
  (pg_temp.uid(3, 2), '2026-10-14', 'complete', '{}', '2026-10-14 07:00+00', '2026-10-14 07:40+00', '2026-10-14 07:40+00', '2026-10-14 07:40+00');
insert into signal_episodes (id, security_id, company_id, kind, mode, threshold_line, opened_scan_run_id, opened_session_date, opened_close, opened_line_value, open_reason, last_evaluated_session_date)
select pg_temp.uid(4, i), pg_temp.uid(2, i), pg_temp.uid(1, i), 'discount', 'worldwide', '-3', pg_temp.uid(3, 1), '2026-10-12', 9, 10, 'new_entry', '2026-10-12' from generate_series(1, 7) i;
-- a complete report for company 5
insert into research_reports (id, security_id, company_id, trigger, status, visibility, idempotency_key, completed_at)
values (pg_temp.uid(5, 5), pg_temp.uid(2, 5), pg_temp.uid(1, 5), 'manual', 'complete', 'public', 'k5', '2026-10-14 08:00+00');

-- previous run lists companies 1, 3, 5, 6; the current run lists 1 (continuing), 2 (re-entering), 3 (new episode again, present before),
-- 4 (pending, new), 5 (researched, new), 6 (withheld red, continuing), 7 (new, listed in Paris)
insert into todays_discounts (scan_run_id, mode, security_id, company_id, episode_id, is_new_episode, rank, close, currency, session_date, threshold_line, lower_line_end, channel, trend_ok, eligibility,
                              operational_category, category_reason, data_freshness, display_order, withheld)
select pg_temp.uid(3, 1), 'worldwide', pg_temp.uid(2, i), pg_temp.uid(1, i), pg_temp.uid(4, i), true, i, 85, 'USD', '2026-10-12', '-3', 90, '{"end":{"lower1":90,"lower2":80}}', true, '{}', 'green', 'meets_checks', 'fresh', i, false
  from unnest(array[1, 3, 5, 6]) i;
insert into todays_discounts (scan_run_id, mode, security_id, company_id, episode_id, is_new_episode, rank, close, currency, session_date, threshold_line, lower_line_end, channel, trend_ok, eligibility,
                              operational_category, category_reason, data_freshness, display_order, withheld) values
  (pg_temp.uid(3, 2), 'worldwide', pg_temp.uid(2, 1), pg_temp.uid(1, 1), pg_temp.uid(4, 1), false, 1, 85, 'USD', '2026-10-13', '-3', 90, '{"end":{"lower1":90,"lower2":80}}', true, '{}', 'green',   'meets_checks',     'fresh', 1, false),
  (pg_temp.uid(3, 2), 'worldwide', pg_temp.uid(2, 2), pg_temp.uid(1, 2), pg_temp.uid(4, 2), false, 2, 85, 'USD', '2026-10-13', '-3', 90, '{"end":{"lower1":90,"lower2":80}}', true, '{}', 'pending', 'research_pending', 'fresh', 2, false),
  (pg_temp.uid(3, 2), 'worldwide', pg_temp.uid(2, 3), pg_temp.uid(1, 3), pg_temp.uid(4, 3), true,  3, 85, 'USD', '2026-10-13', '-3', 90, '{"end":{"lower1":90,"lower2":80}}', true, '{}', 'green',   'meets_checks',     'fresh', 3, false),
  (pg_temp.uid(3, 2), 'worldwide', pg_temp.uid(2, 4), pg_temp.uid(1, 4), pg_temp.uid(4, 4), true,  4, 85, 'USD', '2026-10-13', '-3', 90, '{"end":{"lower1":90,"lower2":80}}', true, '{}', 'pending', 'research_pending', 'fresh', 4, false),
  (pg_temp.uid(3, 2), 'worldwide', pg_temp.uid(2, 5), pg_temp.uid(1, 5), pg_temp.uid(4, 5), true,  5, 85, 'USD', '2026-10-13', '-3', 90, '{"end":{"lower1":90,"lower2":80}}', true, '{}', 'green',   'meets_checks',     'fresh', 5, false),
  (pg_temp.uid(3, 2), 'worldwide', pg_temp.uid(2, 6), pg_temp.uid(1, 6), pg_temp.uid(4, 6), false, 6, 85, 'USD', '2026-10-13', '-3', 90, '{"end":{"lower1":90,"lower2":80}}', true, '{}', 'red',     'meets_checks',     'fresh', 6, true),
  (pg_temp.uid(3, 2), 'worldwide', pg_temp.uid(2, 7), pg_temp.uid(1, 7), pg_temp.uid(4, 7), true,  7, 85, 'USD', '2026-10-13', '-3', 90, '{"end":{"lower1":90,"lower2":80}}', true, '{}', 'pending', 'research_pending', 'fresh', 7, false);
update todays_discounts set research_report_id = pg_temp.uid(5, 5), research_completed_at = '2026-10-14 08:00+00', research_summary = 'Solid.', conclusion = 'Meets these two fundamental checks.', bankruptcy_risk = 'Low'
 where scan_run_id = pg_temp.uid(3, 2) and rank = 5;

insert into auth.users (id, email, email_confirmed_at, instance_id, aud, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'a1@example.com', now(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');
insert into notification_preferences (user_id, email_enabled) values ('00000000-0000-0000-0000-0000000000a1', true);

-- the rule -------------------------------------------------------------------------------------------------------------------
select is((select array_agg(rank order by rank) from public.notify_discount_candidates(pg_temp.uid(3, 2), '00000000-0000-0000-0000-0000000000a1', false)),
          array[2, 3, 4, 5, 7], 'candidates: the re-entering company (2) and the new episodes (3, 4, 5, 7); continuing companies (1, 6) send nothing');
select is((select count(*)::int from public.notify_discount_candidates(pg_temp.uid(3, 2), '00000000-0000-0000-0000-0000000000a1', false) where rank = 2), 1,
          'a company that re-enters after leaving (absent from the previous run, not flagged new) is a candidate');
select is((select count(*)::int from public.notify_discount_candidates(pg_temp.uid(3, 2), '00000000-0000-0000-0000-0000000000a1', false) where rank = 1), 0,
          'a continuing company, present in the previous run and not new, is not a candidate');
select is((select count(*)::int from public.notify_discount_candidates(pg_temp.uid(3, 2), '00000000-0000-0000-0000-0000000000a1', false) where rank = 4), 1,
          'a pending (not researched) company is a candidate');
select is((select count(*)::int from public.notify_discount_candidates(pg_temp.uid(3, 2), '00000000-0000-0000-0000-0000000000a1', false) where rank = 6), 0,
          'a withheld continuing company is not a candidate (it is not new)');
select is((select array_agg(rank order by rank) from public.notify_discount_candidates(pg_temp.uid(3, 2), '00000000-0000-0000-0000-0000000000a1', true)),
          array[2, 3, 4, 5, 7], 'p_finished_only is ignored');
select is((select count(*)::int from public.notify_discount_candidates(pg_temp.uid(3, 1), '00000000-0000-0000-0000-0000000000a1', false)),
          (select count(*)::int from public.todays_discounts where scan_run_id = pg_temp.uid(3, 1)),
          'first-ever published run: every row of todays_discounts is a digest candidate');

-- the research outcome ---------------------------------------------------------------------------------------------------------
select is((select category || '/' || conclusion || '/' || bankruptcy_risk || '/' || summary from public.notify_discount_candidates(pg_temp.uid(3, 2), '00000000-0000-0000-0000-0000000000a1', false) where rank = 5),
          'green/Meets these two fundamental checks./Low/Solid.', 'a complete report supplies the outcome columns');
select ok((select category is null and conclusion is null and bankruptcy_risk is null from public.notify_discount_candidates(pg_temp.uid(3, 2), '00000000-0000-0000-0000-0000000000a1', false) where rank = 4),
          'outcome columns are null when no report exists');
select is((select exchange_code from public.notify_discount_candidates(pg_temp.uid(3, 2), '00000000-0000-0000-0000-0000000000a1', false) where rank = 7), 'PAR',
          'the exchange code is returned so the digest can show the home ticker');

-- filters and carry-over keep working -------------------------------------------------------------------------------------------
update notification_preferences set digest_country_filter = 'France' where user_id = '00000000-0000-0000-0000-0000000000a1';
select is((select array_agg(rank order by rank) from public.notify_discount_candidates(pg_temp.uid(3, 2), '00000000-0000-0000-0000-0000000000a1', false)), array[7],
          'the listing-country filter still applies');
update notification_preferences set digest_country_filter = null where user_id = '00000000-0000-0000-0000-0000000000a1';
insert into digests (id, scan_run_id, kind, user_id, content, content_hash, cutoff_reason)
values (pg_temp.uid(6, 1), pg_temp.uid(3, 2), 'discounts', '00000000-0000-0000-0000-0000000000a1', '{}', 'h', 'complete');
insert into digest_items (digest_id, user_id, ref_type, ref_id) values (pg_temp.uid(6, 1), '00000000-0000-0000-0000-0000000000a1', 'episode', pg_temp.uid(4, 2));
select is((select array_agg(rank order by rank) from public.notify_discount_candidates(pg_temp.uid(3, 2), '00000000-0000-0000-0000-0000000000a1', false)), array[3, 4, 5, 7],
          'A-13 carry-over: an episode already in digest_items is not offered again');
select ok(not has_function_privilege('anon', 'public.notify_discount_candidates(uuid, uuid, boolean)', 'EXECUTE')
      and not has_function_privilege('authenticated', 'public.notify_discount_candidates(uuid, uuid, boolean)', 'EXECUTE')
      and has_function_privilege('service_role', 'public.notify_discount_candidates(uuid, uuid, boolean)', 'EXECUTE'),
          'notify_discount_candidates stays service role only');

select * from finish();
rollback;
