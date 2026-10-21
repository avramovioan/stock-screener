-- Telegram group notifications. Forward-only and replay-safe.
--
-- One row per ready public digest ("new companies on the list", one per scan run): the Telegram message of that digest, with its own
-- status, attempts, next attempt and Telegram message id. notify-dispatch claims due rows, sends them (when TELEGRAM_BOT_TOKEN and
-- TELEGRAM_CHAT_ID are set) and records the outcome. An empty or skipped digest has no row, so nothing is ever sent for it. Retention
-- needs no change: the row cascades with its digest, which the notification purge deletes by age.

create table if not exists telegram_deliveries (
  id uuid primary key default gen_random_uuid(),
  digest_id uuid not null unique references digests on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'skipped')),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  sent_at timestamptz,
  message_id bigint,
  created_at timestamptz not null default now()
);
create index if not exists telegram_deliveries_due on telegram_deliveries (next_attempt_at) where status = 'pending';
alter table telegram_deliveries enable row level security;
revoke all on telegram_deliveries from public, anon, authenticated;

-- The public digest: as before, plus one pending Telegram delivery when the digest is ready.
create or replace function public.notify_insert_public_digest(
  p_scan_run uuid, p_content jsonb, p_hash text, p_reason text, p_status text, p_skip_reason text, p_scan_date text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into digests (scan_run_id, kind, user_id, status, skip_reason, content, content_hash, cutoff_reason)
  values (p_scan_run, 'discounts', null, p_status, p_skip_reason, p_content, p_hash, p_reason)
  on conflict (scan_run_id, kind) where user_id is null do nothing
  returning id into v_id;
  if v_id is null then return null; end if;
  if p_status = 'ready' then
    insert into digest_deliveries (digest_id, user_id, subscription_id, channel, status, idempotency_key)
    select v_id, null, s.id, 'push', 'pending', 'digest:discounts:public:' || s.id::text || ':' || p_scan_date
      from push_subscriptions s
     where s.user_id is null and s.revoked_at is null and s.topic_discounts
    on conflict do nothing;
    insert into telegram_deliveries (digest_id) values (v_id) on conflict (digest_id) do nothing;
  end if;
  return v_id;
end $$;

-- Claim: due pending rows, leased for 10 minutes (the attempt is counted at claim time, like push deliveries).
create or replace function public.notify_telegram_claim(p_limit int) returns setof jsonb
language plpgsql security definer set search_path = public as $$
begin
  return query
  with due as (
    select t.id from telegram_deliveries t
     where t.status = 'pending' and t.next_attempt_at <= now()
     order by t.next_attempt_at
     for update skip locked
     limit p_limit
  ), upd as (
    update telegram_deliveries t
       set attempts = t.attempts + 1, next_attempt_at = now() + interval '10 minutes'
      from due where t.id = due.id
    returning t.*
  )
  select jsonb_build_object('id', u.id, 'digestId', u.digest_id, 'attempts', u.attempts,
    'content', g.content, 'digestCreatedAt', g.created_at, 'scanDate', s.scan_date_local)
    from upd u join digests g on g.id = u.digest_id join scan_runs s on s.id = g.scan_run_id;
end $$;

-- Records the outcome of one attempt. A settled delivery is never changed again.
create or replace function public.notify_telegram_complete(
  p_id uuid, p_status text, p_error text, p_message_id bigint, p_retry_in_seconds int) returns void
language sql security definer set search_path = public as $$
  update telegram_deliveries d set
    status = p_status, last_error = p_error,
    message_id = coalesce(p_message_id, d.message_id),
    sent_at = case when p_status = 'sent' then now() else d.sent_at end,
    next_attempt_at = case when p_retry_in_seconds is not null then now() + make_interval(secs => p_retry_in_seconds) else d.next_attempt_at end
   where d.id = p_id and d.status = 'pending';
$$;

revoke all on function public.notify_insert_public_digest(uuid, jsonb, text, text, text, text, text),
  public.notify_telegram_claim(int), public.notify_telegram_complete(uuid, text, text, bigint, int)
  from public, anon, authenticated;
grant execute on function public.notify_insert_public_digest(uuid, jsonb, text, text, text, text, text),
  public.notify_telegram_claim(int), public.notify_telegram_complete(uuid, text, text, bigint, int)
  to service_role;
