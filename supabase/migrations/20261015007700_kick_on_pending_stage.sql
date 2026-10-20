-- Final fix wave A (engine robustness). Forward-only, replay-safe (create or replace / drop constraint if exists). Sorts after 20261015007600.
--
-- 1) app.kick_workers also fires when an ACTIVE run has a stage waiting to be seeded. Stages are seeded only by a worker whose claim comes
--    back empty; if the last job of a stage ends after the worker's 85 s stop-claiming point, or the isolate dies right after complete_job,
--    nothing is queued and the old condition never kicked, so the run sat in `running` until the next day. Active = status queued, running
--    or partial (scan_status also has complete and failed) with scan_date_local >= Sofia today - 1. The cap of fewer than 2 distinct live
--    leasers is unchanged. Everything else is the definition of 20261015007100.
create or replace function app.kick_workers() returns void
language plpgsql security definer set search_path = public, app, vault, net as $$
declare v_url text; v_secret text; v_hdr jsonb;
begin
  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'worker_tick_secret';
  if v_url is null or v_secret is null then return; end if;
  v_hdr := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret);
  perform app.reap_expired_leases();
  if (exists (select 1 from scan_jobs where status in ('queued', 'failed') and not_before <= now())
      or exists (select 1 from scan_runs r
                  where r.status in ('queued', 'running', 'partial')
                    and r.scan_date_local >= (now() at time zone 'Europe/Sofia')::date - 1
                    and app.next_stage_to_seed(r.id) is not null))
     and (select count(distinct leased_by) from scan_jobs where status = 'leased' and lease_until > now()) < 2 then
    perform net.http_post(url := v_url || '/functions/v1/worker-tick', headers := v_hdr, body := '{}'::jsonb, timeout_milliseconds := 145000);
  end if;
  if app.pending_delivery_count() > 0 then
    perform net.http_post(url := v_url || '/functions/v1/notify-dispatch', headers := v_hdr, body := '{"action":"tick"}'::jsonb, timeout_milliseconds := 145000);
  end if;
end $$;

-- 2) app.claim_jobs takes the per-stage advisory locks for ALL requested stages in sorted order before it touches a row. Taking them in the
--    order the rows are met let two concurrent claimers meet stages in opposite order and deadlock (40P01). The locks are transaction-scoped,
--    so they still serialise the per-stage cap check. Otherwise the definition of 20261015001200.
create or replace function app.claim_jobs(
  p_worker text, p_limit int, p_lease interval, p_stages job_stage[], p_stage_limits jsonb default '{}'::jsonb
) returns setof scan_jobs language plpgsql security definer set search_path = public, app as $$
declare r scan_jobs; n int := 0; lim int; s text;
begin
  perform app.reap_expired_leases();
  for s in select distinct x::text from unnest(p_stages) x order by 1 loop
    perform pg_advisory_xact_lock(hashtext('stage:' || s));                        -- fixed order: no deadlock between claimers
  end loop;
  for r in
    select j.* from scan_jobs j
     where j.status in ('queued', 'failed') and j.not_before <= now() and j.stage = any (p_stages)
     order by j.priority, j.id
     for update skip locked
  loop
    exit when n >= p_limit;
    lim := coalesce((p_stage_limits ->> r.stage::text)::int, 1000);
    continue when (select count(*) from scan_jobs x where x.stage = r.stage and x.status = 'leased' and x.lease_until > now()) >= lim;
    update scan_jobs
       set status = 'leased', leased_by = p_worker, lease_until = now() + p_lease,
           attempts = attempts + 1, started_at = coalesce(started_at, now())
     where id = r.id
    returning * into r;
    update scan_runs
       set status = case when status = 'queued' then 'running'::scan_status else status end, last_heartbeat_at = now()
     where id = r.scan_run_id;
    return next r;
    n := n + 1;
  end loop;
end $$;

-- 3) rank_signals closes the active discount episode of a security that has left the candidate set (no result row for 3 consecutive scans)
--    with the new reason `left_universe`.
alter table signal_episodes drop constraint if exists signal_episodes_close_reason_check;
alter table signal_episodes add constraint signal_episodes_close_reason_check
  check (close_reason in ('close_above_threshold', 'threshold_changed', 'close_below_upper_line', 'left_universe'));
