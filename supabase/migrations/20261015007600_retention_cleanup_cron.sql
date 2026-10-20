-- Daily call of the retention-cleanup Edge Function at 01:30 UTC (spec 6.4). Same pattern as app.kick_workers: pg_net with the
-- Vault secrets project_url and worker_tick_secret (header x-cron-secret = CRON_SHARED_SECRET); a no-op until Vault holds both.
-- Idempotent by job name.
create or replace function app.kick_retention_cleanup() returns void
language plpgsql security definer set search_path = public, app, vault, net as $$
declare v_url text; v_secret text;
begin
  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'worker_tick_secret';
  if v_url is null or v_secret is null then return; end if;
  perform net.http_post(url := v_url || '/functions/v1/retention-cleanup',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
    body := '{}'::jsonb, timeout_milliseconds := 145000);
end $$;
revoke all on function app.kick_retention_cleanup() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'retention-cleanup') then perform cron.unschedule('retention-cleanup'); end if;
end $$;
select cron.schedule('retention-cleanup', '30 1 * * *', 'select app.kick_retention_cleanup();');
