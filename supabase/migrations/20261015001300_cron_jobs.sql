-- P1 / migration 4 of 4: pg_cron entries (spec 7.1). All schedules are UTC. Each job is re-created by name, so the migration is idempotent.
-- The digest, broker and retention entries arrive with the phases that own those functions.
do $$
declare j text;
begin
  foreach j in array array['scan-start-0700', 'scan-start-0800', 'scan-catchup', 'tick-minute', 'purge-cron-history'] loop
    if exists (select 1 from cron.job where jobname = j) then
      perform cron.unschedule(j);
    end if;
  end loop;
end $$;

select cron.schedule('scan-start-0700',    '0 7 * * *',       $$select app.start_daily_scan();$$);       -- 10:00 Sofia in summer time (UTC+3)
select cron.schedule('scan-start-0800',    '0 8 * * *',       $$select app.start_daily_scan();$$);       -- 10:00 Sofia in winter time (UTC+2)
select cron.schedule('scan-catchup',       '*/15 7-11 * * *', $$select app.ensure_scan_today();$$);      -- only acts when the Sofia hour is 10-12
select cron.schedule('tick-minute',        '* * * * *',       $$select app.kick_workers();$$);           -- no-op until Vault holds project_url and worker_tick_secret
select cron.schedule('purge-cron-history', '45 1 * * *',      $$delete from cron.job_run_details where end_time < now() - interval '7 days';$$);
