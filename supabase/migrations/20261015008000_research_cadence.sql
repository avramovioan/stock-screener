-- Research cadence (owner decisions 2026-10-16): re-check every 72 hours, no AI work on weekends, skip scans without a new close.
-- Forward-only and replay-safe (create or replace, if not exists, on conflict). Safe on top of existing rows: nothing is rewritten.
--
-- 1) settings: research.min_recheck_hours = 72 and research.ai_weekdays_only = true (stored values win on a replay).
-- 2) side-channel research jobs: a job whose payload says late = true (work that waits for Monday 10:00 Sofia or for its 72 hour slot)
--    never keeps its scan run open, is not killed by the 22:00 deadline sweep and does not hold the next stage back, like the manual
--    jobs of 20261015002200. The worker claims it when its not_before is due, with or without a scan that day (app.kick_workers
--    already fires on queued jobs whose not_before has passed).
-- 3) skipped scans: app.start_daily_scan does not start a run when no in-scope exchange has completed a session newer than the one
--    the last published run processed (Sunday, Monday morning, US market holidays). The skip is a scan_skipped event plus the public
--    app_settings row last_scan_skip that scan_status() reports as last_skipped; no scan_runs row, so the "last scan" the site shows
--    stays the last real one.

update public.app_settings
   set value = '{"min_recheck_hours": 72, "ai_weekdays_only": true}'::jsonb || value
 where key = 'research';

-- ------------------------------------------------------------------------------------------------ 2) side-channel jobs
create or replace function app.next_stage_to_seed(p_run uuid) returns job_stage
language plpgsql stable security definer set search_path = public, app as $$
declare
  v_stages job_stage[] := array['fx','universe_sweep','identity','eur_catalogue','fetch_bars','compute','rank_signals',
                                'classify','publish','portfolio_scan','news','eur_resolve','research','classify','publish','digest']::job_stage[];
  v_keys   text[]      := array['%','%','%','%','%','%','%',
                                'classify:initial','publish:initial','%','%','%','%','classify:final','publish:final','digest'];
  i int; v_cnt int; v_open int; v_dead int;
begin
  for i in 1 .. array_length(v_stages, 1) loop
    select count(*) into v_cnt from scan_jobs
     where scan_run_id = p_run and stage = v_stages[i] and key like v_keys[i] and coalesce(payload ->> 'late', '') <> 'true';
    if v_cnt = 0 then
      if i = 1 then return v_stages[i]; end if;
      select count(*) filter (where status in ('queued', 'leased', 'failed')), count(*) filter (where status = 'dead')
        into v_open, v_dead
        from scan_jobs
       where scan_run_id = p_run and stage = v_stages[i - 1] and key like v_keys[i - 1] and coalesce(payload ->> 'late', '') <> 'true';
      if v_open > 0 then return null; end if;
      if v_stages[i - 1] in ('fx', 'rank_signals') and v_dead > 0 then return null; end if;
      return v_stages[i];
    end if;
  end loop;
  return null;
end $$;

revoke all on function app.next_stage_to_seed(uuid) from public, anon, authenticated;
grant execute on function app.next_stage_to_seed(uuid) to service_role;

create or replace function app.refresh_scan_status(p_run uuid)
 RETURNS scan_status
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, app
AS $$
declare
  r scan_runs; v_total int; v_open int; v_dead int; v_crit_dead int; v_started boolean; v_more boolean; v_rank_done boolean;
  v_gap int; v_status scan_status; v_hard timestamptz; v_terminal boolean; v_now timestamptz;
begin
  select * into r from scan_runs where id = p_run for update;
  if not found then return null; end if;
  v_hard := (r.scan_date_local + time '22:00') at time zone 'Europe/Sofia';        -- hard deadline (A-15)
  -- a fixture run replays a simulated date: its deadlines are judged one hour after its own start, never against the real clock (7.12)
  v_now := case when r.settings_snapshot ->> 'provider_mode' = 'fixture' then r.started_at + interval '1 hour' else now() end;
  if v_now >= v_hard then
    update scan_jobs set status = 'dead', last_error = 'deadline', lease_until = null, leased_by = null, finished_at = now()
     where scan_run_id = p_run and status in ('queued', 'leased', 'failed')
       and coalesce(payload ->> 'trigger', '') <> 'manual' and coalesce(payload ->> 'late', '') <> 'true';
  end if;
  select count(*),
         count(*) filter (where status in ('queued', 'leased', 'failed')),
         count(*) filter (where status = 'dead'),
         count(*) filter (where status = 'dead' and stage in ('fx', 'rank_signals')),
         coalesce(bool_or(attempts > 0 or status in ('done', 'dead')), false)
    into v_total, v_open, v_dead, v_crit_dead, v_started
    from scan_jobs where scan_run_id = p_run and coalesce(payload ->> 'trigger', '') <> 'manual' and coalesce(payload ->> 'late', '') <> 'true';
  v_more := app.next_stage_to_seed(p_run) is not null;
  v_rank_done := exists (select 1 from scan_jobs where scan_run_id = p_run and stage = 'rank_signals' and status = 'done');
  v_gap := coalesce((r.coverage -> 'candidates' ->> 'failed')::int, 0) + coalesce((r.coverage -> 'candidates' ->> 'unprocessed')::int, 0)
         + coalesce((r.coverage -> 'candidates' ->> 'stale')::int, 0) + coalesce((r.coverage -> 'candidates' ->> 'carried_forward')::int, 0);
  v_terminal := v_total > 0 and v_open = 0 and not v_more;

  if v_crit_dead > 0 or (v_now >= v_hard and not v_rank_done) then
    v_status := 'failed';
  elsif not v_terminal then
    if r.digest_cutoff_at is not null and v_now >= r.digest_cutoff_at then v_status := 'partial';       -- soft deadline (13:00 Sofia)
    elsif v_started then v_status := 'running';
    else v_status := 'queued';
    end if;
  elsif v_dead > 0 or v_gap > 0 then
    v_status := 'partial';
  else
    v_status := 'complete';
  end if;

  update scan_runs
     set status = v_status,
         finished_at = case when v_status = 'failed' or (v_terminal and v_status in ('complete', 'partial')) then coalesce(finished_at, now()) else null end,
         last_heartbeat_at = now()
   where id = p_run;
  if v_status is distinct from r.status then
    insert into scan_events (scan_run_id, level, event, data)
    values (p_run, case when v_status in ('failed', 'partial') then 'warn' else 'info' end, 'scan_status_changed',
            jsonb_build_object('from', r.status, 'to', v_status));
  end if;
  return v_status;
end $$;

revoke all on function app.refresh_scan_status(uuid) from public, anon, authenticated;
grant execute on function app.refresh_scan_status(uuid) to service_role;

-- ------------------------------------------------------------------------------------------------ 3) skipped scans
-- Full-day market closures (no early closes). The US list covers NYSE and Nasdaq; other exchanges have no list here, so a
-- local holiday abroad makes a scan run that finds nothing new, which is harmless (the skip only ever errs towards running).
create table if not exists app.market_holidays (
  market text not null,
  day date not null,
  name text not null,
  primary key (market, day)
);
insert into app.market_holidays (market, day, name) values
 ('us', '2026-01-01', 'New Year''s Day'),
 ('us', '2026-01-19', 'Martin Luther King Jr. Day'),
 ('us', '2026-02-16', 'Washington''s Birthday'),
 ('us', '2026-04-03', 'Good Friday'),
 ('us', '2026-05-25', 'Memorial Day'),
 ('us', '2026-06-19', 'Juneteenth'),
 ('us', '2026-07-03', 'Independence Day'),
 ('us', '2026-09-07', 'Labor Day'),
 ('us', '2026-11-26', 'Thanksgiving Day'),
 ('us', '2026-12-25', 'Christmas Day'),
 ('us', '2027-01-01', 'New Year''s Day'),
 ('us', '2027-01-18', 'Martin Luther King Jr. Day'),
 ('us', '2027-02-15', 'Washington''s Birthday'),
 ('us', '2027-03-26', 'Good Friday'),
 ('us', '2027-05-31', 'Memorial Day'),
 ('us', '2027-06-18', 'Juneteenth'),
 ('us', '2027-07-05', 'Independence Day'),
 ('us', '2027-09-06', 'Labor Day'),
 ('us', '2027-11-25', 'Thanksgiving Day'),
 ('us', '2027-12-24', 'Christmas Day'),
 ('us', '2028-01-17', 'Martin Luther King Jr. Day'),
 ('us', '2028-02-21', 'Washington''s Birthday'),
 ('us', '2028-04-14', 'Good Friday'),
 ('us', '2028-05-29', 'Memorial Day'),
 ('us', '2028-06-19', 'Juneteenth'),
 ('us', '2028-07-04', 'Independence Day'),
 ('us', '2028-09-04', 'Labor Day'),
 ('us', '2028-11-23', 'Thanksgiving Day'),
 ('us', '2028-12-25', 'Christmas Day'),
 ('us', '2029-01-01', 'New Year''s Day'),
 ('us', '2029-01-15', 'Martin Luther King Jr. Day'),
 ('us', '2029-02-19', 'Washington''s Birthday'),
 ('us', '2029-03-30', 'Good Friday'),
 ('us', '2029-05-28', 'Memorial Day'),
 ('us', '2029-06-19', 'Juneteenth'),
 ('us', '2029-07-04', 'Independence Day'),
 ('us', '2029-09-03', 'Labor Day'),
 ('us', '2029-11-22', 'Thanksgiving Day'),
 ('us', '2029-12-25', 'Christmas Day'),
 ('us', '2030-01-01', 'New Year''s Day'),
 ('us', '2030-01-21', 'Martin Luther King Jr. Day'),
 ('us', '2030-02-18', 'Washington''s Birthday'),
 ('us', '2030-04-19', 'Good Friday'),
 ('us', '2030-05-27', 'Memorial Day'),
 ('us', '2030-06-19', 'Juneteenth'),
 ('us', '2030-07-04', 'Independence Day'),
 ('us', '2030-09-02', 'Labor Day'),
 ('us', '2030-11-28', 'Thanksgiving Day'),
 ('us', '2030-12-25', 'Christmas Day')
on conflict (market, day) do nothing;
revoke all on app.market_holidays from public, anon, authenticated;
grant select on app.market_holidays to service_role;

-- Scope of the skip decision: "us" (default) looks at the US exchanges only, "all" at every enabled exchange.
insert into public.app_settings (key, value, is_public, description)
values ('scan_cadence', '{"skip_without_new_session": true, "session_scope": "us"}'::jsonb, false,
        'Daily scan cadence: skip the scan when no in-scope exchange completed a new session (session_scope us | all)')
on conflict (key) do nothing;

-- The newest session of an exchange that has completed (its close has passed) at p_now, skipping non-trading weekdays and, for the
-- US exchanges, the full-day holidays of app.market_holidays.
create or replace function app.last_completed_session(p_exchange text, p_now timestamptz) returns date
language plpgsql stable security definer set search_path = public, app as $$
declare
  ex exchanges%rowtype; v_local timestamp; v_day date; i int;
begin
  select * into ex from exchanges where code = p_exchange;
  if not found then return null; end if;
  v_local := p_now at time zone ex.timezone;
  v_day := v_local::date;
  -- today's session counts once its close has passed; an exchange without a close time counts only when the day is over
  if ex.session_close_local is null or v_local::time < ex.session_close_local then
    v_day := v_day - 1;
  end if;
  for i in 1 .. 14 loop
    exit when extract(isodow from v_day)::int = any (ex.trading_days)
          and not (ex.us_primary and exists (select 1 from app.market_holidays h where h.market = 'us' and h.day = v_day));
    v_day := v_day - 1;
  end loop;
  return v_day;
end $$;

-- { skip, reason, scope, expected, previous }: skip is true when every comparable in-scope exchange's newest completed session is not
-- newer than the one the last published run processed (scan_runs.session_dates). No previous run, or no comparable exchange: run.
create or replace function app.scan_session_check(p_now timestamptz) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare
  v_cfg jsonb := coalesce((select value from app_settings where key = 'scan_cadence'), '{}'::jsonb);
  v_scope text := case when v_cfg ->> 'session_scope' = 'all' then 'all' else 'us' end;
  v_prev jsonb; v_expected jsonb := '{}'::jsonb; v_known int := 0; v_new int := 0;
  r record; v_last date; v_prev_day date;
begin
  if coalesce((v_cfg ->> 'skip_without_new_session')::boolean, true) is not true then
    return jsonb_build_object('skip', false, 'reason', 'disabled', 'scope', v_scope);
  end if;
  select session_dates into v_prev from scan_runs
   where results_published_at is not null and session_dates <> '{}'::jsonb
   order by scan_date_local desc limit 1;
  if v_prev is null then
    return jsonb_build_object('skip', false, 'reason', 'no_previous_run', 'scope', v_scope);
  end if;
  for r in select code from exchanges where screener_enabled and (v_scope = 'all' or us_primary) order by code loop
    v_last := app.last_completed_session(r.code, p_now);
    v_expected := v_expected || jsonb_build_object(r.code, v_last);
    v_prev_day := (v_prev ->> r.code)::date;
    if v_prev_day is null or v_last is null then continue; end if;
    v_known := v_known + 1;
    if v_last > v_prev_day then v_new := v_new + 1; end if;
  end loop;
  return jsonb_build_object('skip', v_known > 0 and v_new = 0,
                            'reason', case when v_known = 0 then 'no_comparable_session' when v_new = 0 then 'no_new_session' else 'new_session' end,
                            'scope', v_scope, 'expected', v_expected, 'previous', v_prev);
end $$;

revoke all on function app.last_completed_session(text, timestamptz) from public, anon, authenticated;
revoke all on function app.scan_session_check(timestamptz) from public, anon, authenticated;
grant execute on function app.last_completed_session(text, timestamptz) to service_role;
grant execute on function app.scan_session_check(timestamptz) to service_role;

-- Daily start with the skip. Cron starts only ('cron', 'cron_catchup', not a fixture run) can be skipped: a manual or forced
-- start always runs. The skip is recorded once per day. Everything else is the definition of 20261015001200.
create or replace function app.start_daily_scan(
  p_now timestamptz default now(), p_force boolean default false, p_trigger text default 'cron', p_snapshot_extra jsonb default '{}'::jsonb
) returns uuid language plpgsql security definer set search_path = public, app as $$
declare v_date date := (p_now at time zone 'Europe/Sofia')::date; v_id uuid; v_check jsonb;
begin
  -- DST-safe guard: only the 07:00 UTC entry (summer, UTC+3) or the 08:00 UTC entry (winter, UTC+2) passes (7.2)
  if not p_force and extract(hour from (p_now at time zone 'Europe/Sofia')) <> 10 then
    return null;
  end if;
  if p_trigger in ('cron', 'cron_catchup')
     and coalesce(p_snapshot_extra ->> 'provider_mode', '') <> 'fixture'
     and not exists (select 1 from scan_runs where scan_date_local = v_date) then
    v_check := app.scan_session_check(p_now);
    if (v_check ->> 'skip')::boolean then
      if not exists (select 1 from scan_events where event = 'scan_skipped' and data ->> 'scan_date_local' = v_date::text) then
        insert into scan_events (scan_run_id, level, event, data)
        values (null, 'info', 'scan_skipped', v_check || jsonb_build_object('scan_date_local', v_date, 'trigger', p_trigger));
      end if;
      insert into app_settings (key, value, is_public, description)
      values ('last_scan_skip',
              jsonb_build_object('scan_date_local', v_date, 'at', p_now, 'reason', v_check ->> 'reason', 'scope', v_check ->> 'scope'),
              true, 'The latest daily scan that was skipped because no exchange had a new completed session')
      on conflict (key) do update set value = excluded.value, updated_at = now()
        where (app_settings.value ->> 'scan_date_local') is distinct from (excluded.value ->> 'scan_date_local');
      return null;
    end if;
  end if;
  insert into scan_runs (scan_date_local, status, trigger, started_at, settings_snapshot, digest_cutoff_at)
  values (v_date, 'queued', p_trigger, p_now, app.current_settings_snapshot() || coalesce(p_snapshot_extra, '{}'::jsonb),
          ((v_date + time '13:00') at time zone 'Europe/Sofia'))
  on conflict (scan_date_local) do nothing
  returning id into v_id;
  if v_id is null then return null; end if;                 -- already started today: idempotent no-op
  insert into scan_jobs (scan_run_id, stage, key, priority) values (v_id, 'fx', 'all', 10) on conflict do nothing;
  insert into scan_events (scan_run_id, level, event, data)
  values (v_id, 'info', 'scan_started', jsonb_build_object('scan_date_local', v_date, 'trigger', p_trigger));
  perform app.kick_workers();
  return v_id;
end $$;

-- scan_status() also reports the latest skipped day, so the health check and the Overview can tell "nothing new to scan" from "the
-- scan stopped". last_attempted and last_successful are untouched: a skipped day is not a run.
create or replace function public.scan_status() returns jsonb language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'last_attempted', (select to_jsonb(r) from (select scan_date_local, started_at, status from scan_runs order by started_at desc limit 1) r),
    'last_successful', (select to_jsonb(r) from (select scan_date_local, finished_at from scan_runs where status = 'complete' order by finished_at desc limit 1) r),
    'latest_published', (select to_jsonb(r) from (select scan_date_local, status, latest_session_date, coverage, results_published_at, list_published_at
                                                     from scan_runs where results_published_at is not null order by scan_date_local desc limit 1) r),
    'last_skipped', (select value from app_settings where key = 'last_scan_skip' and is_public))
$$;
