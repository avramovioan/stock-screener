-- Research cadence (migration 20261015008000): settings, side-channel (late) research jobs, skipped scans, completed-session dates
-- across DST weeks and US holidays. 65 assertions.
begin;
create extension if not exists pgtap with schema extensions;
truncate public.todays_discounts, public.signal_episodes, public.universe_membership_events, public.universe_snapshots, public.scan_security_results, public.scan_events, public.scan_jobs, public.market_cap_snapshots, public.scan_runs restart identity cascade;
delete from public.app_settings where key = 'last_scan_skip';
select plan(66);

-- settings -------------------------------------------------------------------------------------------------------------
select is((select (value ->> 'min_recheck_hours')::int from public.app_settings where key = 'research'), 72, 'research.min_recheck_hours defaults to 72');
select is((select (value ->> 'ai_weekdays_only')::boolean from public.app_settings where key = 'research'), true, 'research.ai_weekdays_only defaults to true');
select is((select value ->> 'max_full_reports_per_day' from public.app_settings where key = 'research'), null, 'the null report cap from the earlier migration is kept');
select is((select (value ->> 'tavily_daily_cap')::int from public.app_settings where key = 'research'), 60, 'the other research keys are kept (tavily_daily_cap is 60 since 20261015008800)');
-- replay: the statement of the migration keeps a stored value
update public.app_settings set value = jsonb_set(value, '{min_recheck_hours}', '48') where key = 'research';
update public.app_settings set value = '{"min_recheck_hours": 72, "ai_weekdays_only": true}'::jsonb || value where key = 'research';
select is((select (value ->> 'min_recheck_hours')::int from public.app_settings where key = 'research'), 48, 'a replay keeps a stored min_recheck_hours');
update public.app_settings set value = jsonb_set(value, '{min_recheck_hours}', '72') where key = 'research';
select is((select value from public.app_settings where key = 'scan_cadence'), '{"skip_without_new_session": true, "session_scope": "all"}'::jsonb, 'scan_cadence defaults to skipping, scope all (20261015008100)');
-- the checks below that read the default pin the US scope; the all-scope checks follow after them
update public.app_settings set value = jsonb_set(value, '{session_scope}', '"us"') where key = 'scan_cadence';
select is((select is_public from public.app_settings where key = 'scan_cadence'), false, 'scan_cadence is not public');

-- app.last_completed_session ---------------------------------------------------------------------------------------------
select is(app.last_completed_session('NYQ', '2026-10-17 07:00+00'), date '2026-10-16', 'Saturday morning: Friday is the last US session');
select is(app.last_completed_session('NYQ', '2026-10-18 07:00+00'), date '2026-10-16', 'Sunday morning: still Friday');
select is(app.last_completed_session('NYQ', '2026-10-19 07:00+00'), date '2026-10-16', 'Monday 10:00 Sofia is 03:00 in New York: still Friday');
select is(app.last_completed_session('NYQ', '2026-10-20 07:00+00'), date '2026-10-19', 'Tuesday morning: Monday');
select is(app.last_completed_session('NYQ', '2026-10-20 19:59+00'), date '2026-10-19', 'one minute before the New York close (15:59 EDT): the day does not count yet');
select is(app.last_completed_session('NYQ', '2026-10-20 20:00+00'), date '2026-10-20', 'at the close (16:00 EDT) it does');
select is(app.last_completed_session('NYQ', '2026-11-02 20:59+00'), date '2026-10-30', 'after the US clocks went back (EST), 20:59Z is 15:59: Friday');
select is(app.last_completed_session('NYQ', '2026-11-02 21:00+00'), date '2026-11-02', 'and 21:00Z is the 16:00 close');
select is(app.last_completed_session('NYQ', '2026-03-09 19:59+00'), date '2026-03-06', 'after the US clocks went forward (EDT) the close is 20:00Z: 19:59Z is 15:59, Friday');
select is(app.last_completed_session('NYQ', '2026-03-09 20:00+00'), date '2026-03-09', 'and 20:00Z is the close');
select is(app.last_completed_session('NYQ', '2026-11-27 07:00+00'), date '2026-11-25', 'Friday after Thanksgiving (Thursday 2026-11-26 is a holiday): Wednesday');
select is(app.last_completed_session('NMS', '2026-12-26 07:00+00'), date '2026-12-24', 'Saturday after Christmas (Friday 2026-12-25): Thursday');
select is(app.last_completed_session('NYQ', '2026-07-06 07:00+00'), date '2026-07-02', 'Monday after the observed Independence Day (Friday 2026-07-03): Thursday');
select is(app.last_completed_session('NYQ', '2026-04-04 07:00+00'), date '2026-04-02', 'Saturday after Good Friday (2026-04-03): Thursday');
select is(app.last_completed_session('GER', '2026-10-19 07:00+00'), date '2026-10-16', 'Xetra on Monday morning: Friday');
select is(app.last_completed_session('GER', '2026-10-19 16:30+00'), date '2026-10-19', 'Xetra closes 17:30 CEST = 15:30Z: Monday counts at 16:30Z');
select is(app.last_completed_session('JPX', '2026-10-19 07:00+00'), date '2026-10-19', 'Tokyo (15:30 JST = 06:30Z) has completed Monday by 10:00 Sofia');
select is(app.last_completed_session('SAU', '2026-10-18 07:00+00'), date '2026-10-15', 'Saudi trades Sunday to Thursday: on Sunday morning the last completed session is Thursday');
select is(app.last_completed_session('NOPE', '2026-10-19 07:00+00'), null, 'an unknown exchange has no session');

-- app.scan_session_check ---------------------------------------------------------------------------------------------------
insert into public.scan_runs (id, scan_date_local, status, settings_snapshot, started_at, finished_at, results_published_at, list_published_at, session_dates, latest_session_date)
values ('95000000-0000-4000-8000-000000000001', '2026-10-16', 'complete', '{}', '2026-10-16 07:00+00', '2026-10-16 07:40+00', '2026-10-16 07:40+00', '2026-10-16 07:40+00',
        '{"NMS":"2026-10-15","NYQ":"2026-10-15","JPX":"2026-10-16"}', '2026-10-16');
select is((app.scan_session_check('2026-10-17 07:00+00') ->> 'skip')::boolean, false, 'Saturday: Friday close is new, scan');
select is(app.scan_session_check('2026-10-17 07:00+00') ->> 'reason', 'new_session', 'with the reason new_session');
select is((app.scan_session_check('2026-10-17 07:00+00') -> 'expected' ->> 'NYQ'), '2026-10-16', 'and the expected session dates are reported');
update public.scan_runs set session_dates = '{"NMS":"2026-10-16","NYQ":"2026-10-16","JPX":"2026-10-16"}' where id = '95000000-0000-4000-8000-000000000001';
select is((app.scan_session_check('2026-10-18 07:00+00') ->> 'skip')::boolean, true, 'Sunday: nothing new in the US since Friday, skip');
select is(app.scan_session_check('2026-10-18 07:00+00') ->> 'reason', 'no_new_session', 'with the reason no_new_session');
select is((app.scan_session_check('2026-10-19 07:00+00') ->> 'skip')::boolean, true, 'Monday morning: skip (the US has not opened)');
select is((app.scan_session_check('2026-10-20 07:00+00') ->> 'skip')::boolean, false, 'Tuesday: Monday close is new, scan');

-- scope all: Tokyo closed Monday before 10:00 Sofia, so Monday needs a scan
update public.app_settings set value = jsonb_set(value, '{session_scope}', '"all"') where key = 'scan_cadence';
select is((app.scan_session_check('2026-10-19 07:00+00') ->> 'skip')::boolean, false, 'scope all: Tokyo has a new Monday session, scan');
select is(app.scan_session_check('2026-10-19 07:00+00') ->> 'scope', 'all', 'and the scope is reported');
select is((app.scan_session_check('2026-10-18 07:00+00') ->> 'skip')::boolean, true, 'scope all: Sunday is still the weekly no-op');
update public.app_settings set value = jsonb_set(value, '{session_scope}', '"us"') where key = 'scan_cadence';
-- skipping switched off
update public.app_settings set value = jsonb_set(value, '{skip_without_new_session}', 'false') where key = 'scan_cadence';
select is((app.scan_session_check('2026-10-18 07:00+00') ->> 'skip')::boolean, false, 'skip_without_new_session = false: always scan');
update public.app_settings set value = jsonb_set(value, '{skip_without_new_session}', 'true') where key = 'scan_cadence';
-- an unknown scope falls back to us
update public.app_settings set value = jsonb_set(value, '{session_scope}', '"galaxy"') where key = 'scan_cadence';
select is(app.scan_session_check('2026-10-18 07:00+00') ->> 'scope', 'us', 'an unknown scope is treated as us');
update public.app_settings set value = jsonb_set(value, '{session_scope}', '"us"') where key = 'scan_cadence';

-- app.start_daily_scan ------------------------------------------------------------------------------------------------------
select is(app.start_daily_scan('2026-10-18 07:00+00'), null, 'Sunday 10:00 Sofia: skipped, no run id');
select is((select count(*)::int from public.scan_runs where scan_date_local = '2026-10-18'), 0, 'and no scan_runs row exists for Sunday (the last scan the site shows stays the real one)');
select is((select count(*)::int from public.scan_events where event = 'scan_skipped' and data ->> 'scan_date_local' = '2026-10-18'), 1, 'one scan_skipped event with the Sunday date');
select is((select data ->> 'reason' from public.scan_events where event = 'scan_skipped' and data ->> 'scan_date_local' = '2026-10-18'), 'no_new_session', 'carrying the reason');
select is(app.start_daily_scan('2026-10-18 07:00+00'), null, 'a second call the same day is still a no-op');
select is(app.ensure_scan_today('2026-10-18 08:30+00'), null, 'so is the catch-up at 11:30 Sofia');
select is((select count(*)::int from public.scan_events where event = 'scan_skipped' and data ->> 'scan_date_local' = '2026-10-18'), 1, 'the skip is recorded once per day');
select is(public.scan_status() -> 'last_skipped' ->> 'scan_date_local', '2026-10-18', 'scan_status() reports the skipped day');
select is(public.scan_status() -> 'last_successful' ->> 'scan_date_local', '2026-10-16', 'and still reports the last real successful scan');
select is(public.scan_status() -> 'last_attempted' ->> 'scan_date_local', '2026-10-16', 'and the last attempt is the last real run');
select is(app.start_daily_scan('2026-10-19 07:00+00'), null, 'Monday morning: skipped too');
select is(public.scan_status() -> 'last_skipped' ->> 'scan_date_local', '2026-10-19', 'last_skipped moves to Monday');
select isnt(app.start_daily_scan('2026-10-20 07:00+00'), null, 'Tuesday: a scan starts (Monday close)');
select isnt(app.start_daily_scan('2026-10-25 08:00+00', true, 'manual'), null, 'a forced manual start is never skipped (Sunday 2026-10-25, the Sofia clocks change that day)');
select isnt(app.start_daily_scan('2026-11-01 08:00+00', false, 'cron', '{"provider_mode":"fixture","fixture_set":"day1"}'), null, 'a fixture run is never skipped (Sunday)');

-- DST weeks (Sofia clocks changed 2026-10-25, New York clocks 2026-11-01)
insert into public.scan_runs (id, scan_date_local, status, settings_snapshot, started_at, finished_at, results_published_at, list_published_at, session_dates)
values ('95000000-0000-4000-8000-000000000003', '2026-10-31', 'complete', '{}', '2026-10-31 08:00+00', '2026-10-31 08:40+00', '2026-10-31 08:40+00', '2026-10-31 08:40+00',
        '{"NMS":"2026-10-30","NYQ":"2026-10-30"}');
select is(app.start_daily_scan('2026-11-01 08:00+00'), null, 'Sunday 2026-11-01 (10:00 EET): skip');
select is(app.start_daily_scan('2026-11-02 08:00+00'), null, 'Monday 2026-11-02 (10:00 EET, 03:00 EST): skip');
select isnt(app.start_daily_scan('2026-11-03 08:00+00'), null, 'Tuesday 2026-11-03: Monday close, scan');

-- US holiday: Thanksgiving 2026-11-26
insert into public.scan_runs (id, scan_date_local, status, settings_snapshot, started_at, finished_at, results_published_at, list_published_at, session_dates)
values ('95000000-0000-4000-8000-000000000002', '2026-11-26', 'complete', '{}', '2026-11-26 08:00+00', '2026-11-26 08:40+00', '2026-11-26 08:40+00', '2026-11-26 08:40+00',
        '{"NMS":"2026-11-25","NYQ":"2026-11-25"}');
select is(app.start_daily_scan('2026-11-27 08:00+00'), null, 'Friday after Thanksgiving: the market was closed Thursday, skip');
select isnt(app.start_daily_scan('2026-11-28 08:00+00'), null, 'Saturday: Friday''s session is new, scan');

-- no usable previous run: always scan (the first runs of a fresh database)
delete from public.scan_events;
delete from public.scan_runs where id in ('95000000-0000-4000-8000-000000000001', '95000000-0000-4000-8000-000000000002', '95000000-0000-4000-8000-000000000003');
select is((app.scan_session_check('2026-10-18 07:00+00') ->> 'skip')::boolean, false, 'no published run with session dates: scan');

-- side-channel (late) research jobs ----------------------------------------------------------------------------------------------
create temp table stages(stage job_stage, ord int, key text default 'k');
insert into stages (stage, ord) values ('fx',1),('universe_sweep',2),('identity',3),('eur_catalogue',4),('fetch_bars',5),('compute',6),('rank_signals',7),('classify',8),('publish',9),('portfolio_scan',10),('news',11),('eur_resolve',12),('research',13),('classify',14),('publish',15),('digest',16);
update stages set key = case ord when 16 then 'digest' when 8 then 'classify:initial' when 9 then 'publish:initial' when 14 then 'classify:final' when 15 then 'publish:final' else key end;

insert into public.scan_runs (id, scan_date_local, settings_snapshot) values ('95000000-0000-4000-8000-0000000000a1', '2026-01-06', '{}');
insert into public.scan_jobs (scan_run_id, stage, key, status, attempts, finished_at)
select '95000000-0000-4000-8000-0000000000a1', stage, key, 'done', 1, now() from stages where ord <= 13;
insert into public.scan_jobs (scan_run_id, stage, key, status, payload, not_before)
values ('95000000-0000-4000-8000-0000000000a1', 'research', 'research:late', 'queued', '{"late": true}', now() + interval '3 days');
select is(app.next_stage_to_seed('95000000-0000-4000-8000-0000000000a1'), 'classify'::job_stage, 'a queued late research job does not hold classify:final back');
insert into public.scan_jobs (scan_run_id, stage, key, status, payload) values ('95000000-0000-4000-8000-0000000000a1', 'research', 'research:open', 'queued', '{}');
select is(app.next_stage_to_seed('95000000-0000-4000-8000-0000000000a1')::text, null, 'an ordinary open research job still does');
delete from public.scan_jobs where key = 'research:open';

insert into public.scan_jobs (scan_run_id, stage, key, status, attempts, finished_at)
select '95000000-0000-4000-8000-0000000000a1', stage, key, 'done', 1, now() from stages where ord > 13;
select is(app.refresh_scan_status('95000000-0000-4000-8000-0000000000a1'), 'complete'::scan_status, 'a run whose only open job is a late job is complete (the deadline of 2026-01-06 is long past in the sweep too)');
select is((select status::text from public.scan_jobs where key = 'research:late'), 'queued', 'the deadline sweep leaves the late job alone');

insert into public.scan_runs (id, scan_date_local, settings_snapshot) values ('95000000-0000-4000-8000-0000000000a2', '2026-01-07', '{}');
insert into public.scan_jobs (scan_run_id, stage, key, status, attempts, finished_at)
select '95000000-0000-4000-8000-0000000000a2', stage, key, 'done', 1, now() from stages where ord <= 12;
insert into public.scan_jobs (scan_run_id, stage, key, status, payload) values ('95000000-0000-4000-8000-0000000000a2', 'research', 'research:ordinary', 'queued', '{}');
select app.refresh_scan_status('95000000-0000-4000-8000-0000000000a2');
select is((select status::text from public.scan_jobs where key = 'research:ordinary'), 'dead', 'control: an ordinary open job is killed by the deadline sweep');

-- the late job is claimed once its not_before is due, whatever the run's state
update public.scan_jobs set not_before = now() - interval '1 minute' where key = 'research:late';
select is((select count(*)::int from app.claim_jobs('w-late', 5, interval '1 minute', array['research']::job_stage[]) where key = 'research:late'), 1, 'a due late job of a finished run is claimed');
select is((select count(*)::int from public.scan_jobs where key = 'research:late' and status = 'leased'), 1, 'and leased');

select * from finish();
rollback;
