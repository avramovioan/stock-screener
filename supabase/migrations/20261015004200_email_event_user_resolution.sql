-- P3 Task 5 security fixes.
-- 1. A bounce/complaint with no matching delivery must not be lost: the Edge Function resolves the user from the
--    recipient hash (keyed with RECIPIENT_HASH_SECRET, which never reaches the database) and passes p_user. If no user
--    can be resolved the function returns 'unresolved' WITHOUT storing the dedupe row, so Resend/Svix retries.
-- 2. Atomic per-user push subscription cap and a per-user rate limit for the test push.

drop function if exists public.notify_record_email_event(text, text, text, text, jsonb);

create or replace function public.notify_record_email_event(
  p_svix_id text, p_type text, p_email_id text, p_recipient_hash text, p_payload jsonb, p_user uuid default null)
returns text
language plpgsql security definer set search_path = public as $$
declare v_event bigint; v_delivery uuid; v_user uuid;
begin
  select id, user_id into v_delivery, v_user from digest_deliveries where provider_message_id = p_email_id limit 1;
  v_user := coalesce(v_user, p_user);
  if v_user is null and p_type in ('email.bounced', 'email.complained', 'email.suppressed') then
    if exists (select 1 from email_events where svix_id = p_svix_id) then return 'duplicate'; end if;
    return 'unresolved';
  end if;
  insert into email_events (svix_id, delivery_id, type, email_id, recipient_hash, payload)
  values (p_svix_id, v_delivery, p_type, p_email_id, p_recipient_hash, p_payload)
  on conflict (svix_id) do nothing returning id into v_event;
  if v_event is null then return 'duplicate'; end if;
  if p_type = 'email.delivered' then
    if v_delivery is not null then update digest_deliveries set delivered_at = now() where id = v_delivery; end if;
  elsif p_type = 'email.failed' then
    if v_delivery is not null then
      update digest_deliveries set status = 'failed', last_error = 'resend_failed' where id = v_delivery;
    end if;
  elsif p_type in ('email.bounced', 'email.complained', 'email.suppressed') then
    if v_delivery is not null then
      update digest_deliveries set status = 'bounced', last_error = p_type where id = v_delivery;
    end if;
    insert into notification_preferences (user_id, email_enabled, email_unsubscribed_at, email_bounced_at)
      values (v_user, false, now(), now())
      on conflict (user_id) do update set email_enabled = false,
        email_unsubscribed_at = coalesce(notification_preferences.email_unsubscribed_at, now()),
        email_bounced_at = coalesce(notification_preferences.email_bounced_at, now());
  end if;
  return 'recorded';
end $$;

-- Candidate recipients for hash resolution (service role only; the function hashes in memory, nothing is logged).
create or replace function public.notify_recipient_candidates() returns table (user_id uuid, email text)
language sql stable security definer set search_path = public, auth as $$
  select u.id, u.email::text from auth.users u where u.email is not null;
$$;

-- Atomic cap: the advisory lock serialises concurrent subscribes of one user.
create or replace function public.notify_subscribe(
  p_user uuid, p_endpoint text, p_p256dh text, p_auth text, p_user_agent text, p_max int) returns text
language plpgsql security definer set search_path = public as $$
declare v_count int;
begin
  perform pg_advisory_xact_lock(hashtextextended('notify_subscribe:' || p_user::text, 0));
  select count(*) into v_count from push_subscriptions
   where user_id = p_user and revoked_at is null and endpoint <> p_endpoint;
  if v_count >= p_max then return 'too_many'; end if;
  insert into push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  values (p_user, p_endpoint, p_p256dh, p_auth, p_user_agent)
  on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
    user_agent = excluded.user_agent, revoked_at = null, revoke_reason = null, failure_count = 0;
  return 'ok';
end $$;

alter table push_subscriptions add column if not exists last_test_at timestamptz;

-- true when the test push is allowed (at most one per minute and user; the lock makes check and stamp atomic)
create or replace function public.notify_claim_push_test(p_user uuid) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('notify_push_test:' || p_user::text, 0));
  if exists (select 1 from push_subscriptions where user_id = p_user and last_test_at > now() - interval '1 minute') then
    return false;
  end if;
  update push_subscriptions set last_test_at = now() where user_id = p_user and revoked_at is null;
  return true;
end $$;

revoke all on function public.notify_record_email_event(text, text, text, text, jsonb, uuid),
  public.notify_recipient_candidates(), public.notify_subscribe(uuid, text, text, text, text, int),
  public.notify_claim_push_test(uuid) from public, anon, authenticated;
grant execute on function public.notify_record_email_event(text, text, text, text, jsonb, uuid),
  public.notify_recipient_candidates(), public.notify_subscribe(uuid, text, text, text, text, int),
  public.notify_claim_push_test(uuid) to service_role;
