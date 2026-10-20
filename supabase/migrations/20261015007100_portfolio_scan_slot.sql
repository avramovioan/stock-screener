-- P5b / portfolio_scan stage slot (spec 7.4 stage 8) and a single broker-sync kick path.
-- Forward-only, replay-safe (create or replace). Sorts after 20261015007000, so apply with `supabase migration up --include-all`
-- on a database that already ran the earlier files.
--
-- 1) app.next_stage_to_seed gets the `portfolio_scan` slot between publish:initial and news. The stage handler always seeds its
--    `premium` and `risk_set` jobs, so a run without holdings still passes the slot and completes.
--    Everything else is identical to 20261015004300.
create or replace function app.next_stage_to_seed(p_run uuid) returns job_stage
language plpgsql stable security definer set search_path = public, app as $$
declare
  v_stages job_stage[] := array['fx','universe_sweep','identity','fetch_bars','compute','rank_signals',
                                'classify','publish','portfolio_scan','news','research','classify','publish','digest']::job_stage[];
  v_keys   text[]      := array['%','%','%','%','%','%',
                                'classify:initial','publish:initial','%','%','%','classify:final','publish:final','digest'];
  i int; v_cnt int; v_open int; v_dead int;
begin
  for i in 1 .. array_length(v_stages, 1) loop
    select count(*) into v_cnt from scan_jobs where scan_run_id = p_run and stage = v_stages[i] and key like v_keys[i];
    if v_cnt = 0 then
      if i = 1 then return v_stages[i]; end if;
      select count(*) filter (where status in ('queued', 'leased', 'failed')), count(*) filter (where status = 'dead')
        into v_open, v_dead
        from scan_jobs where scan_run_id = p_run and stage = v_stages[i - 1] and key like v_keys[i - 1];
      if v_open > 0 then return null; end if;
      if v_stages[i - 1] in ('fx', 'rank_signals') and v_dead > 0 then return null; end if;
      return v_stages[i];
    end if;
  end loop;
  return null;
end $$;

revoke all on function app.next_stage_to_seed(uuid) from public, anon, authenticated;
grant execute on function app.next_stage_to_seed(uuid) to service_role;

-- 2) kick_workers no longer kicks broker-sync: the dedicated `broker-tick` cron entry (app.kick_broker_sync) is the only path, so a
--    due run is never started by two concurrent invocations. The rest of the body is the definition of 20261015004000 without the broker branch.
create or replace function app.kick_workers() returns void
language plpgsql security definer set search_path = public, app, vault, net as $$
declare v_url text; v_secret text; v_hdr jsonb;
begin
  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'worker_tick_secret';
  if v_url is null or v_secret is null then return; end if;
  v_hdr := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret);
  perform app.reap_expired_leases();
  if exists (select 1 from scan_jobs where status in ('queued', 'failed') and not_before <= now())
     and (select count(distinct leased_by) from scan_jobs where status = 'leased' and lease_until > now()) < 2 then
    perform net.http_post(url := v_url || '/functions/v1/worker-tick', headers := v_hdr, body := '{}'::jsonb, timeout_milliseconds := 145000);
  end if;
  if app.pending_delivery_count() > 0 then
    perform net.http_post(url := v_url || '/functions/v1/notify-dispatch', headers := v_hdr, body := '{"action":"tick"}'::jsonb, timeout_milliseconds := 145000);
  end if;
end $$;
