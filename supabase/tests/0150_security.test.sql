begin;
create extension if not exists pgtap with schema extensions;
select plan(10);

-- (a) every table in public has RLS enabled
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity),
  0,
  'every public table has row level security enabled (without: '
    || coalesce((select string_agg(c.relname, ', ') from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity), 'none') || ')');

-- (b) every SECURITY DEFINER function in app and public pins its search_path
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('app', 'public') and p.prosecdef
      and not coalesce(exists (select 1 from unnest(p.proconfig) cfg where cfg like 'search_path=%'), false)),
  0,
  'every security definer function in app/public pins search_path (without: '
    || coalesce((select string_agg(n.nspname || '.' || p.proname, ', ') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname in ('app', 'public') and p.prosecdef
                    and not coalesce(exists (select 1 from unnest(p.proconfig) cfg where cfg like 'search_path=%'), false)), 'none') || ')');

-- (c) kick_workers is a no-op without Vault secrets and never leaks the secret
delete from vault.secrets where name in ('project_url', 'worker_tick_secret');
insert into scan_runs (id, scan_date_local, settings_snapshot) values ('00000000-0000-0000-0000-0000000000e1', date '2030-01-01' + 90, '{}');
insert into scan_jobs (scan_run_id, stage, key, status, not_before) values ('00000000-0000-0000-0000-0000000000e1', 'compute', 'k', 'queued', now() - interval '1 minute');
create temp table _q0 as select count(*)::int as n from net.http_request_queue;
select lives_ok($$select app.kick_workers()$$, 'kick_workers raises nothing with an empty Vault');
select is((select count(*)::int from net.http_request_queue), (select n from _q0), 'kick_workers enqueues no request without Vault secrets');
select vault.create_secret('http://example.invalid', 'project_url');
select vault.create_secret('dummy-secret-value-7f3a9c', 'worker_tick_secret');
select app.kick_workers();
select is((select count(*)::int from net.http_request_queue), (select n + 1 from _q0), 'kick_workers enqueues one request once the secrets exist');
select is((select count(*)::int from scan_events where data::text like '%dummy-secret-value-7f3a9c%' or event like '%dummy-secret-value-7f3a9c%'), 0, 'the secret value never appears in scan_events');

-- (d) cron entries and idempotent re-run of the migration body
select is((select count(*)::int from cron.job), 12, 'cron.job holds exactly twelve entries');
select set_eq(
  $$select jobname, schedule from cron.job$$,
  $$values ('scan-start-0700', '0 7 * * *'), ('scan-start-0800', '0 8 * * *'), ('scan-catchup', '*/15 7-11 * * *'),
           ('tick-minute', '* * * * *'), ('purge-cron-history', '45 1 * * *'),
           ('digest-cutoff-1000', '0 10 * * *'), ('digest-cutoff-1100', '0 11 * * *'),
           ('broker-daily-0500', '0 5 * * *'), ('broker-daily-0600', '0 6 * * *'), ('broker-tick', '* * * * *'),
           ('retention-notifications', '40 1 * * *'), ('retention-cleanup', '30 1 * * *')$$,
  'the twelve jobs carry the exact schedules');

do $$
declare j text;
begin
  foreach j in array array['scan-start-0700', 'scan-start-0800', 'scan-catchup', 'tick-minute', 'purge-cron-history', 'digest-cutoff-1000', 'digest-cutoff-1100', 'broker-daily-0500', 'broker-daily-0600', 'broker-tick', 'retention-notifications', 'retention-cleanup'] loop
    if exists (select 1 from cron.job where jobname = j) then
      perform cron.unschedule(j);
    end if;
  end loop;
end $$;
select cron.schedule('scan-start-0700',    '0 7 * * *',       $$select app.start_daily_scan();$$);
select cron.schedule('scan-start-0800',    '0 8 * * *',       $$select app.start_daily_scan();$$);
select cron.schedule('scan-catchup',       '*/15 7-11 * * *', $$select app.ensure_scan_today();$$);
select cron.schedule('tick-minute',        '* * * * *',       $$select app.kick_workers();$$);
select cron.schedule('purge-cron-history', '45 1 * * *',      $$delete from cron.job_run_details where end_time < now() - interval '7 days';$$);
select cron.schedule('digest-cutoff-1000', '0 10 * * *', $$select app.cutoff_digests();$$);
select cron.schedule('digest-cutoff-1100', '0 11 * * *', $$select app.cutoff_digests();$$);
select cron.schedule('broker-daily-0500', '0 5 * * *', $$select app.start_daily_broker_syncs();$$);
select cron.schedule('broker-daily-0600', '0 6 * * *', $$select app.start_daily_broker_syncs();$$);
select cron.schedule('broker-tick', '* * * * *', $$select app.kick_broker_sync();$$);
select cron.schedule('retention-notifications', '40 1 * * *', $$select app.purge_notifications();$$);
select cron.schedule('retention-cleanup', '30 1 * * *', $$select app.kick_retention_cleanup();$$);
select is((select count(*)::int from cron.job), 12, 're-running the migration bodies leaves exactly twelve entries');
select is((select count(distinct jobname)::int from cron.job where jobname in ('scan-start-0700', 'scan-start-0800', 'scan-catchup', 'tick-minute', 'purge-cron-history', 'digest-cutoff-1000', 'digest-cutoff-1100', 'broker-daily-0500', 'broker-daily-0600', 'broker-tick', 'retention-notifications', 'retention-cleanup')), 12, 'and each named entry exists once');

select * from finish();
rollback;
