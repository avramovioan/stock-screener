-- P2 / manual research jobs (research_now) are an operator side channel: they never keep a run open, never flip a finished run
-- back, and the 22:00 Sofia deadline sweep does not kill them. Everything else is unchanged from 20261015001200.
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
     where scan_run_id = p_run and status in ('queued', 'leased', 'failed') and coalesce(payload ->> 'trigger', '') <> 'manual';
  end if;
  select count(*),
         count(*) filter (where status in ('queued', 'leased', 'failed')),
         count(*) filter (where status = 'dead'),
         count(*) filter (where status = 'dead' and stage in ('fx', 'rank_signals')),
         coalesce(bool_or(attempts > 0 or status in ('done', 'dead')), false)
    into v_total, v_open, v_dead, v_crit_dead, v_started
    from scan_jobs where scan_run_id = p_run and coalesce(payload ->> 'trigger', '') <> 'manual';
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
