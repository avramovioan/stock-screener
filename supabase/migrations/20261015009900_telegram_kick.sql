-- Telegram rows wake the dispatcher. Forward-only and replay-safe (create or replace). Sorts after 20261015009800.
--
-- Root cause: the minute cron app.kick_workers() calls notify-dispatch only when app.pending_delivery_count() > 0, and that count looked at
-- digest_deliveries only. A due telegram_deliveries row therefore never woke the dispatcher by itself: a Telegram message went out only when
-- a push delivery happened to be due in the same minute, and a Telegram retry (next_attempt_at in the future) was never picked up.
-- Fix: the count also includes due pending Telegram deliveries. Signature, security and grants are unchanged.
create or replace function app.pending_delivery_count() returns int
language sql stable security definer set search_path = public as $$
  select (select count(*) from digest_deliveries where status = 'pending' and next_attempt_at <= now())::int
       + (select count(*) from telegram_deliveries where status = 'pending' and next_attempt_at <= now())::int;
$$;
revoke all on function app.pending_delivery_count() from public, anon, authenticated;
grant execute on function app.pending_delivery_count() to service_role;

-- Operator action telegram_send_latest: queue the Telegram message of the latest ready public discounts digest (younger than 24 hours).
-- No row yet: insert one. failed or skipped: reset to pending, 0 attempts, due now. sent: nothing. Then kick the dispatcher.
create or replace function public.telegram_queue_latest() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_digest uuid; v_date text; v_status text;
begin
  select g.id, s.scan_date_local::text into v_digest, v_date
    from digests g join scan_runs s on s.id = g.scan_run_id
   where g.user_id is null and g.kind = 'discounts' and g.status = 'ready' and g.created_at > now() - interval '24 hours'
   order by g.created_at desc limit 1;
  if v_digest is null then return jsonb_build_object('queued', false, 'reason', 'no_ready_digest'); end if;
  select t.status into v_status from telegram_deliveries t where t.digest_id = v_digest;
  if v_status = 'sent' then
    return jsonb_build_object('queued', false, 'reason', 'already_sent', 'digest_id', v_digest, 'scan_date', v_date);
  end if;
  if v_status is null then
    insert into telegram_deliveries (digest_id) values (v_digest) on conflict (digest_id) do nothing;
  elsif v_status in ('failed', 'skipped') then
    update telegram_deliveries set status = 'pending', attempts = 0, next_attempt_at = now(), last_error = null where digest_id = v_digest;
  end if;
  perform app.kick_workers();
  return jsonb_build_object('queued', true, 'digest_id', v_digest, 'scan_date', v_date);
end $$;
revoke all on function public.telegram_queue_latest() from public, anon, authenticated;
grant execute on function public.telegram_queue_latest() to service_role;
