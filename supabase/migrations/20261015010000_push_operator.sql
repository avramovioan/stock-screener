-- Operator push actions of scan-control: push_test and push_send_latest. Forward-only and replay-safe. Sorts after 20261015009900.

-- Last run of an operator action that is rate limited. One row per action; no policies, so only the service role (which bypasses RLS) reaches it.
create table if not exists push_operator_runs (
  action text primary key,
  last_run_at timestamptz not null
);
alter table push_operator_runs enable row level security;
revoke all on push_operator_runs from anon, authenticated;

-- push_test: claims the five-minute window and returns every active device (signed in or anonymous).
-- {status:'rate_limited', retry_after_seconds} inside the window, else {status:'ok', devices:[{id, endpoint, p256dh, auth}]}.
create or replace function public.push_claim_test() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_last timestamptz; v_devices jsonb;
begin
  insert into push_operator_runs (action, last_run_at) values ('push_test', now())
  on conflict (action) do update set last_run_at = now()
   where push_operator_runs.last_run_at <= now() - interval '5 minutes'
  returning last_run_at into v_last;
  if v_last is null then
    select last_run_at into v_last from push_operator_runs where action = 'push_test';
    return jsonb_build_object('status', 'rate_limited',
      'retry_after_seconds', greatest(1, ceil(extract(epoch from (v_last + interval '5 minutes' - now())))::int));
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth) order by s.created_at), '[]'::jsonb)
    into v_devices from push_subscriptions s where s.revoked_at is null;
  return jsonb_build_object('status', 'ok', 'devices', v_devices);
end $$;

-- push_send_latest: the latest ready public discounts digest younger than 24 hours. Active anonymous devices with the discounts topic and no
-- delivery for it get a pending one; failed or skipped deliveries go back to pending (0 attempts, due now); sent ones stay. Then the dispatcher is kicked.
create or replace function public.push_queue_latest() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_digest uuid; v_date text; v_new int; v_reset int; v_sent int;
begin
  select g.id, s.scan_date_local::text into v_digest, v_date
    from digests g join scan_runs s on s.id = g.scan_run_id
   where g.user_id is null and g.kind = 'discounts' and g.status = 'ready' and g.created_at > now() - interval '24 hours'
   order by g.created_at desc limit 1;
  if v_digest is null then return jsonb_build_object('reason', 'no_ready_digest'); end if;
  with ins as (
    insert into digest_deliveries (digest_id, user_id, subscription_id, channel, status, idempotency_key)
    select v_digest, null, s.id, 'push', 'pending', 'digest:discounts:public:' || s.id::text || ':' || v_date
      from push_subscriptions s
     where s.user_id is null and s.revoked_at is null and s.topic_discounts
       and not exists (select 1 from digest_deliveries d where d.digest_id = v_digest and d.subscription_id = s.id)
    on conflict do nothing
    returning 1)
  select count(*) into v_new from ins;
  with upd as (
    update digest_deliveries set status = 'pending', attempts = 0, next_attempt_at = now(), last_error = null
     where digest_id = v_digest and subscription_id is not null and channel = 'push' and status in ('failed', 'skipped')
    returning 1)
  select count(*) into v_reset from upd;
  select count(*) into v_sent from digest_deliveries
   where digest_id = v_digest and subscription_id is not null and channel = 'push' and status = 'sent';
  perform app.kick_workers();
  return jsonb_build_object('digest_id', v_digest, 'scan_date', v_date, 'queued', v_new + v_reset, 'already_sent', v_sent);
end $$;

revoke all on function public.push_claim_test(), public.push_queue_latest() from public, anon, authenticated;
grant execute on function public.push_claim_test(), public.push_queue_latest() to service_role;
