-- Retention for notification data (spec 6.4, D14): digests, items, deliveries and email events 180 days;
-- revoked push subscriptions 30 days. A digest that still references an active episode or an open risk
-- finding (risk_findings.resolved_at is null) is kept so digest_items dedupe never breaks. Runs from its own cron
-- entry so it does not depend on how app.purge_expired is written.
create or replace function app.purge_notifications(p_batch int default 5000) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare v_digests int; v_events int; v_subs int;
begin
  with doomed as (
    select g.id from digests g
     where g.created_at < now() - interval '180 days'
       and not exists (select 1 from digest_items i join signal_episodes e on e.id = i.ref_id
                        where i.digest_id = g.id and i.ref_type = 'episode' and e.status = 'active')
       and not exists (select 1 from digest_items i join risk_findings f on f.id = i.ref_id
                        where i.digest_id = g.id and i.ref_type = 'finding' and f.resolved_at is null)
     order by g.created_at limit p_batch)
  delete from digests where id in (select id from doomed);
  get diagnostics v_digests = row_count;

  delete from email_events where id in (select id from email_events where received_at < now() - interval '180 days' order by id limit p_batch);
  get diagnostics v_events = row_count;

  delete from push_subscriptions where id in (select id from push_subscriptions where revoked_at < now() - interval '30 days' limit p_batch);
  get diagnostics v_subs = row_count;

  return jsonb_build_object('digests', v_digests, 'email_events', v_events, 'push_subscriptions', v_subs);
end $$;
revoke all on function app.purge_notifications(int) from public, anon, authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'retention-notifications') then perform cron.unschedule('retention-notifications'); end if;
end $$;
select cron.schedule('retention-notifications', '40 1 * * *', 'select app.purge_notifications();');
