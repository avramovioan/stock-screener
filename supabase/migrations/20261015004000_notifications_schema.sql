-- P3 notifications: enums, tables, RLS and column privileges, then functions (spec 6.3.6, 6.8, 6.9, 10).

create type digest_kind      as enum ('discounts', 'portfolio');
create type delivery_channel as enum ('push', 'email');
create type delivery_status  as enum ('pending', 'sent', 'failed', 'skipped', 'bounced');

alter table scan_runs add column if not exists digests_created_at timestamptz;

create table notification_preferences (
  user_id uuid primary key references auth.users on delete cascade,
  push_enabled boolean not null default false,
  email_enabled boolean not null default false,
  digest_modes universe_mode[] not null default '{worldwide}',
  send_empty boolean not null default false,
  email_unsubscribed_at timestamptz,
  email_bounced_at timestamptz,
  updated_at timestamptz not null default now()
);

create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  failure_count int not null default 0,
  revoked_at timestamptz,
  revoke_reason text
);
create index push_subscriptions_active on push_subscriptions (user_id) where revoked_at is null;

create table digests (
  id uuid primary key default gen_random_uuid(),
  scan_run_id uuid not null references scan_runs,
  kind digest_kind not null,
  user_id uuid not null references auth.users on delete cascade,
  status text not null default 'ready' check (status in ('ready', 'skipped')),
  skip_reason text,
  content jsonb not null default '{}',
  content_hash text not null,
  cutoff_reason text not null check (cutoff_reason in ('complete', 'cutoff')),
  created_at timestamptz not null default now(),
  unique (scan_run_id, kind, user_id)
);

create table digest_items (
  id bigint generated always as identity primary key,
  digest_id uuid not null references digests on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  ref_type text not null check (ref_type in ('episode', 'finding')),
  ref_id uuid not null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (user_id, ref_type, ref_id)
);
create index digest_items_digest on digest_items (digest_id);

create table digest_deliveries (
  id uuid primary key default gen_random_uuid(),
  digest_id uuid not null references digests on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  channel delivery_channel not null,
  status delivery_status not null default 'pending',
  skip_reason text,
  attempts int not null default 0,
  provider_message_id text,
  last_error text,
  idempotency_key text not null check (char_length(idempotency_key) <= 256),
  attempt_log jsonb not null default '[]',
  quota_consumed boolean not null default false,
  next_attempt_at timestamptz not null default now(),
  sent_at timestamptz,
  delivered_at timestamptz,
  unique (digest_id, user_id, channel)
);
create index digest_deliveries_due on digest_deliveries (next_attempt_at) where status = 'pending';
create index digest_deliveries_provider on digest_deliveries (provider_message_id) where provider_message_id is not null;

create table email_events (
  id bigint generated always as identity primary key,
  svix_id text not null unique,
  delivery_id uuid references digest_deliveries on delete set null,
  type text not null,
  email_id text,
  recipient_hash text,
  payload jsonb,
  received_at timestamptz not null default now()
);

-- RLS and privileges ------------------------------------------------------------------------------
alter table notification_preferences enable row level security;
alter table push_subscriptions       enable row level security;
alter table digests                  enable row level security;
alter table digest_items             enable row level security;
alter table digest_deliveries        enable row level security;
alter table email_events             enable row level security;

revoke all on notification_preferences, push_subscriptions, digests, digest_items, digest_deliveries, email_events
  from anon, authenticated;

grant select on notification_preferences to authenticated;
grant insert (user_id, push_enabled, email_enabled, digest_modes, send_empty) on notification_preferences to authenticated;
grant update (push_enabled, email_enabled, digest_modes, send_empty, email_unsubscribed_at) on notification_preferences to authenticated;
grant select (id, user_id, user_agent, created_at, last_success_at, last_failure_at, failure_count, revoked_at, revoke_reason)
  on push_subscriptions to authenticated;
grant delete on push_subscriptions to authenticated;
grant select on digests, digest_items to authenticated;
grant select (id, digest_id, user_id, channel, status, skip_reason, attempts, sent_at, delivered_at)
  on digest_deliveries to authenticated;

create policy prefs_select_own on notification_preferences for select to authenticated using (user_id = auth.uid());
create policy prefs_insert_own on notification_preferences for insert to authenticated with check (user_id = auth.uid());
create policy prefs_update_own on notification_preferences for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy subs_select_own on push_subscriptions for select to authenticated using (user_id = auth.uid());
create policy subs_delete_own on push_subscriptions for delete to authenticated using (user_id = auth.uid());
create policy digests_select_own on digests for select to authenticated using (user_id = auth.uid());
create policy items_select_own on digest_items for select to authenticated using (user_id = auth.uid());
create policy deliveries_select_own on digest_deliveries for select to authenticated using (user_id = auth.uid());
-- email_events: no policies = deny by default for clients.

-- A client may only CLEAR email_unsubscribed_at (re-enable); only the service role sets it. ----------------
create or replace function app.notification_preferences_guard() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' and current_user in ('authenticated', 'anon')
     and new.email_unsubscribed_at is not null
     and new.email_unsubscribed_at is distinct from old.email_unsubscribed_at then
    raise exception 'email_unsubscribed_at can only be cleared by the user' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger notification_preferences_guard before insert or update on notification_preferences
  for each row execute function app.notification_preferences_guard();

-- Event helper (does not depend on the P1 app.record_event signature) ------------------------------------
create or replace function public.notify_event(p_scan_run uuid, p_level text, p_event text, p_data jsonb default '{}')
returns void language sql security definer set search_path = public as $$
  insert into scan_events (scan_run_id, stage, level, event, data) values (p_scan_run, 'digest', p_level, p_event, p_data);
$$;

-- Quota with an explicit cap (A-25). Adaptation: delegates to P2's app.consume_quota (int columns). ------------
create or replace function app.consume_quota_capped(p_provider text, p_resource text, p_amount bigint, p_period_kind text, p_limit bigint)
returns boolean language sql security definer set search_path = public, app as $$
  select app.consume_quota(p_provider, p_resource, p_amount::int, p_period_kind, p_limit::int);
$$;

-- Cut-off at 13:00 Europe/Sofia (spec 7.10); two cron entries, one hour guard ------------------------------
create or replace function app.cutoff_digests(p_now timestamptz default now()) returns int
language plpgsql security definer set search_path = public, app as $$
declare v_local timestamp := p_now at time zone 'Europe/Sofia'; r record; n int := 0;
begin
  if extract(hour from v_local)::int <> 13 then return 0; end if;
  for r in select id from scan_runs
           where scan_date_local = v_local::date and status in ('running', 'partial') and digests_created_at is null
  loop
    insert into scan_jobs (scan_run_id, stage, key, priority) values (r.id, 'digest', 'digest:cutoff', 5)
      on conflict (scan_run_id, stage, key) do nothing;
    update scan_runs set status = 'partial', updated_at = now() where id = r.id and status = 'running';
    n := n + 1;
  end loop;
  if n > 0 then perform app.kick_workers(); end if;
  return n;
end $$;

create or replace function app.pending_delivery_count() returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from digest_deliveries where status = 'pending' and next_attempt_at <= now();
$$;

-- Claim: portfolio before discounts, FOR UPDATE SKIP LOCKED, lease through next_attempt_at -------------------
create or replace function app.claim_deliveries(p_limit int) returns setof jsonb
language plpgsql security definer set search_path = public, app, auth as $$
begin
  return query
  with due as (
    select d.id from digest_deliveries d join digests g on g.id = d.digest_id
    where d.status = 'pending' and d.next_attempt_at <= now()
    order by (g.kind = 'portfolio') desc, d.next_attempt_at
    for update of d skip locked
    limit p_limit
  ), upd as (
    update digest_deliveries d
       set attempts = d.attempts + 1, next_attempt_at = now() + interval '10 minutes'
      from due where d.id = due.id
    returning d.*
  )
  select jsonb_build_object(
    'id', u.id, 'digestId', u.digest_id, 'userId', u.user_id, 'channel', u.channel, 'attempts', u.attempts,
    'idempotencyKey', u.idempotency_key, 'quotaConsumed', u.quota_consumed,
    'kind', g.kind, 'content', g.content, 'scanRunId', g.scan_run_id, 'digestCreatedAt', g.created_at,
    'scanDate', s.scan_date_local,
    'prefs', jsonb_build_object(
      'pushEnabled', coalesce(p.push_enabled, false), 'emailEnabled', coalesce(p.email_enabled, false),
      'emailUnsubscribedAt', p.email_unsubscribed_at, 'emailBouncedAt', p.email_bounced_at,
      'emailConfirmed', (a.email_confirmed_at is not null)),
    'email', case when u.channel = 'email' then a.email end)
  from upd u
  join digests g on g.id = u.digest_id
  join scan_runs s on s.id = g.scan_run_id
  left join notification_preferences p on p.user_id = u.user_id
  left join auth.users a on a.id = u.user_id;
end $$;

-- kick_workers: P1 body (worker-tick) plus notify-dispatch when deliveries are due and broker-sync when present.
create or replace function app.kick_workers() returns void
language plpgsql security definer set search_path = public, app, vault, net as $$
declare v_url text; v_secret text; v_hdr jsonb; v_broker boolean := false;
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
  if to_regclass('public.broker_sync_runs') is not null then
    execute $q$select exists (select 1 from broker_sync_runs where state in ('queued','requested','polling') and coalesce(next_poll_at, now()) <= now())$q$ into v_broker;
    if v_broker then
      perform net.http_post(url := v_url || '/functions/v1/broker-sync', headers := v_hdr, body := '{"action":"tick"}'::jsonb, timeout_milliseconds := 145000);
    end if;
  end if;
end $$;

revoke all on function app.cutoff_digests(timestamptz), app.pending_delivery_count(), app.claim_deliveries(int),
  app.consume_quota_capped(text, text, bigint, text, bigint), public.notify_event(uuid, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.notify_event(uuid, text, text, jsonb) to service_role;
grant execute on function app.consume_quota_capped(text, text, bigint, text, bigint) to service_role;

-- Users who can receive a digest: at least one channel enabled ------------------------------------------------
create or replace function public.notify_digest_users() returns table (
  user_id uuid, push_enabled boolean, email_enabled boolean, email_ok boolean, has_active_push boolean,
  digest_modes universe_mode[], send_empty boolean, holds_positions boolean)
language plpgsql security definer set search_path = public, auth as $$
declare v_holds text := case when to_regclass('public.broker_positions') is not null
  then 'exists (select 1 from broker_positions b where b.user_id = p.user_id)' else 'false' end;
begin
  return query execute format($q$
    select p.user_id, p.push_enabled, p.email_enabled,
           (a.email_confirmed_at is not null and p.email_unsubscribed_at is null and p.email_bounced_at is null),
           exists (select 1 from push_subscriptions s where s.user_id = p.user_id and s.revoked_at is null),
           p.digest_modes, p.send_empty, %s
      from notification_preferences p join auth.users a on a.id = p.user_id
     where p.push_enabled or p.email_enabled
     order by p.user_id$q$, v_holds);
end $$;

-- Discount candidates of one run for one user: green/amber, not withheld, restricted to the user's modes,
-- no digest_items row yet (A-13 carry-over), and at the cut-off only finished research.
-- Adaptations: report/summary come from the P2 columns (research_report_id, research_summary) with the P1 ones as
-- fallback; eur_equivalents does not exist yet, so the EUR columns are typed nulls.
create or replace function public.notify_discount_candidates(p_scan_run uuid, p_user uuid, p_finished_only boolean)
returns table (episode_id uuid, company_id uuid, security_id uuid, mode universe_mode, rank int, yahoo_symbol text,
  name text, close float8, currency text, session_date date, threshold_line text, category text, conclusion text,
  bankruptcy_risk text, summary text, eur_symbol text, eur_status text)
language sql stable security definer set search_path = public as $$
  select t.episode_id, t.company_id, t.security_id, t.mode, t.rank, s.yahoo_symbol, c.name, t.close, t.currency,
         t.session_date, t.threshold_line::text, t.operational_category::text, t.conclusion, t.bankruptcy_risk::text,
         coalesce(t.research_summary, t.summary, ''), null::text, null::text
    from todays_discounts t
    join securities s on s.id = t.security_id
    join companies c on c.id = t.company_id
    join notification_preferences p on p.user_id = p_user
   where t.scan_run_id = p_scan_run
     and t.mode = any (p.digest_modes)
     and t.operational_category in ('green', 'amber')
     and not t.withheld
     and (not p_finished_only or (coalesce(t.research_report_id, t.report_id) is not null and t.research_completed_at is not null))
     and not exists (select 1 from digest_items i where i.user_id = p_user and i.ref_type = 'episode' and i.ref_id = t.episode_id)
   order by t.mode, t.rank, s.yahoo_symbol;
$$;

-- Portfolio candidates: premium episodes opened in this run on held securities + the user's unnotified open findings.
-- Adaptations: risk_findings are per user (user_id, resolved_at null = open, notified_at) and need no broker_positions;
-- the premium part needs broker_positions (P5) and is empty until it exists.
create or replace function public.notify_portfolio_candidates(p_scan_run uuid, p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_premium jsonb := '[]'; v_risks jsonb := '[]';
begin
  if to_regclass('public.broker_positions') is not null then
    execute $q$
      select coalesce(jsonb_agg(jsonb_build_object(
        'episodeId', e.id, 'securityId', e.security_id, 'yahooSymbol', s.yahoo_symbol, 'name', c.name,
        'kind', e.kind, 'close', e.opened_close, 'ccy', s.currency, 'sessionDate', e.opened_session_date,
        'researchStatus', coalesce((select r.status::text from research_reports r where r.security_id = e.security_id and r.is_current limit 1), 'queued'))
        order by s.yahoo_symbol), '[]')
        from signal_episodes e join securities s on s.id = e.security_id join companies c on c.id = e.company_id
       where e.opened_scan_run_id = $1 and e.kind in ('premium1', 'premium2') and e.status = 'active' and e.notify
         and exists (select 1 from broker_positions b where b.user_id = $2 and b.security_id = e.security_id)
         and not exists (select 1 from digest_items i where i.user_id = $2 and i.ref_type = 'episode' and i.ref_id = e.id)$q$
      into v_premium using p_scan_run, p_user;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', f.id, 'securityId', f.security_id, 'yahooSymbol', s.yahoo_symbol, 'name', c.name,
      'category', f.category, 'summary', f.summary, 'detectedOn', f.detected_at::date,
      'researchStatus', coalesce((select r.status::text from research_reports r where r.security_id = f.security_id and r.is_current limit 1), 'queued'))
      order by s.yahoo_symbol, f.detected_at), '[]')
    into v_risks
    from risk_findings f join securities s on s.id = f.security_id join companies c on c.id = s.company_id
   where f.user_id = p_user and f.resolved_at is null and f.notified_at is null
     and not exists (select 1 from digest_items i where i.user_id = p_user and i.ref_type = 'finding' and i.ref_id = f.id);
  return jsonb_build_object('premium', v_premium, 'risks', v_risks);
end $$;

-- One transaction per digest: digest + items + deliveries (+ finding stamps). Returns null when it already existed.
-- p_items: [{"ref_type":"episode","ref_id":"...","payload":{}}]; p_channels: [{"channel":"push","status":"pending","skip_reason":null}]
create or replace function public.notify_insert_digest(
  p_scan_run uuid, p_user uuid, p_kind digest_kind, p_content jsonb, p_hash text, p_reason text,
  p_status text, p_skip_reason text, p_items jsonb, p_channels jsonb, p_scan_date text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; it jsonb; ch jsonb;
begin
  insert into digests (scan_run_id, kind, user_id, status, skip_reason, content, content_hash, cutoff_reason)
  values (p_scan_run, p_kind, p_user, p_status, p_skip_reason, p_content, p_hash, p_reason)
  on conflict (scan_run_id, kind, user_id) do nothing
  returning id into v_id;
  if v_id is null then return null; end if;
  if p_status = 'ready' then
    for it in select * from jsonb_array_elements(p_items) loop
      insert into digest_items (digest_id, user_id, ref_type, ref_id, payload)
      values (v_id, p_user, it->>'ref_type', (it->>'ref_id')::uuid, coalesce(it->'payload', '{}'))
      on conflict (user_id, ref_type, ref_id) do nothing;
      if it->>'ref_type' = 'finding' then
        update risk_findings set notified_at = coalesce(notified_at, now()) where id = (it->>'ref_id')::uuid;
      end if;
    end loop;
    for ch in select * from jsonb_array_elements(p_channels) loop
      insert into digest_deliveries (digest_id, user_id, channel, status, skip_reason, idempotency_key)
      values (v_id, p_user, (ch->>'channel')::delivery_channel, (ch->>'status')::delivery_status, ch->>'skip_reason',
              'digest:' || p_kind::text || ':' || p_user::text || ':' || p_scan_date)
      on conflict (digest_id, user_id, channel) do nothing;
    end loop;
  end if;
  return v_id;
end $$;

create or replace function public.notify_finish_digests(p_scan_run uuid, p_reason text, p_stats jsonb) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  update scan_runs set digests_created_at = now(), updated_at = now() where id = p_scan_run and digests_created_at is null;
  get diagnostics v_n = row_count;
  if v_n > 0 then
    perform public.notify_event(p_scan_run, 'info', 'digest_created', p_stats || jsonb_build_object('reason', p_reason));
  end if;
  return v_n > 0;
end $$;

create or replace function public.notify_active_subscriptions(p_user uuid)
returns table (id uuid, endpoint text, p256dh text, auth text)
language sql stable security definer set search_path = public as $$
  select s.id, s.endpoint, s.p256dh, s.auth from push_subscriptions s
   where s.user_id = p_user and s.revoked_at is null order by s.created_at;
$$;

-- outcome: success | failure | gone. 5 consecutive failures revoke (spec 10.4).
create or replace function public.notify_mark_subscription(p_id uuid, p_outcome text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_outcome = 'success' then
    update push_subscriptions set last_success_at = now(), failure_count = 0 where id = p_id;
  elsif p_outcome = 'gone' then
    update push_subscriptions set revoked_at = now(), revoke_reason = 'gone', last_failure_at = now()
     where id = p_id and revoked_at is null;
  elsif p_outcome = 'failure' then
    update push_subscriptions
       set failure_count = failure_count + 1, last_failure_at = now(),
           revoke_reason = case when failure_count + 1 >= 5 and revoked_at is null then 'repeated_failure' else revoke_reason end,
           revoked_at = case when failure_count + 1 >= 5 and revoked_at is null then now() else revoked_at end
     where id = p_id;
  else
    raise exception 'bad outcome %', p_outcome;
  end if;
end $$;

-- One transition function for a delivery. p_retry_in_seconds not null = stays pending with backoff.
create or replace function public.notify_complete_delivery(
  p_id uuid, p_status delivery_status, p_skip_reason text, p_error text, p_message_id text,
  p_retry_in_seconds int, p_log jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare v_scan uuid; v_channel delivery_channel; v_attempts int;
begin
  update digest_deliveries d set
    status = p_status, skip_reason = p_skip_reason, last_error = p_error,
    provider_message_id = coalesce(p_message_id, d.provider_message_id),
    sent_at = case when p_status = 'sent' then now() else d.sent_at end,
    next_attempt_at = case when p_retry_in_seconds is not null then now() + make_interval(secs => p_retry_in_seconds) else d.next_attempt_at end,
    attempt_log = d.attempt_log || jsonb_build_array(p_log || jsonb_build_object('at', now()))
  where d.id = p_id and d.status = 'pending'
  returning d.channel, d.attempts into v_channel, v_attempts;
  if v_channel is null then return; end if;
  select g.scan_run_id into v_scan from digest_deliveries d join digests g on g.id = d.digest_id where d.id = p_id;
  if p_status = 'sent' then
    perform public.notify_event(v_scan, 'info', 'delivery_sent',
      jsonb_build_object('delivery_id', p_id, 'channel', v_channel, 'attempts', v_attempts));
  elsif p_status in ('failed', 'bounced') then
    perform public.notify_event(v_scan, 'warn', 'delivery_failed',
      jsonb_build_object('delivery_id', p_id, 'channel', v_channel, 'attempts', v_attempts, 'error', p_error));
  end if;
end $$;

-- Consume one unit of the email cap once per delivery (quota_consumed makes a retry free).
create or replace function public.notify_consume_email_quota(p_delivery uuid, p_limit bigint) returns boolean
language plpgsql security definer set search_path = public, app as $$
begin
  if (select quota_consumed from digest_deliveries where id = p_delivery) then return true; end if;
  if app.consume_quota_capped('resend', 'email_day', 1, 'day', p_limit) then
    update digest_deliveries set quota_consumed = true where id = p_delivery;
    return true;
  end if;
  return false;
end $$;

-- Webhook effects, atomic and idempotent by svix_id. Returns 'duplicate' or 'recorded'.
create or replace function public.notify_record_email_event(
  p_svix_id text, p_type text, p_email_id text, p_recipient_hash text, p_payload jsonb) returns text
language plpgsql security definer set search_path = public as $$
declare v_event bigint; v_delivery uuid; v_user uuid;
begin
  select id, user_id into v_delivery, v_user from digest_deliveries where provider_message_id = p_email_id limit 1;
  insert into email_events (svix_id, delivery_id, type, email_id, recipient_hash, payload)
  values (p_svix_id, v_delivery, p_type, p_email_id, p_recipient_hash, p_payload)
  on conflict (svix_id) do nothing returning id into v_event;
  if v_event is null then return 'duplicate'; end if;
  if v_delivery is null then return 'recorded'; end if;
  if p_type = 'email.delivered' then
    update digest_deliveries set delivered_at = now() where id = v_delivery;
  elsif p_type = 'email.failed' then
    update digest_deliveries set status = 'failed', last_error = 'resend_failed' where id = v_delivery;
  elsif p_type in ('email.bounced', 'email.complained', 'email.suppressed') then
    update digest_deliveries set status = 'bounced', last_error = p_type where id = v_delivery;
    insert into notification_preferences (user_id, email_enabled, email_unsubscribed_at, email_bounced_at)
      values (v_user, false, now(), now())
      on conflict (user_id) do update set email_enabled = false,
        email_unsubscribed_at = coalesce(notification_preferences.email_unsubscribed_at, now()),
        email_bounced_at = coalesce(notification_preferences.email_bounced_at, now());
  end if;
  return 'recorded';
end $$;

-- One-click unsubscribe (idempotent, audited as notify.unsubscribe).
-- Adaptation: audit_events has (actor_id, action, target_type, target_id, details), not the brief's column names.
create or replace function public.notify_unsubscribe(p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into notification_preferences (user_id, email_enabled, email_unsubscribed_at) values (p_user, false, now())
  on conflict (user_id) do update set email_enabled = false,
    email_unsubscribed_at = coalesce(notification_preferences.email_unsubscribed_at, now());
  update digest_deliveries set status = 'skipped', skip_reason = 'unsubscribed'
   where user_id = p_user and channel = 'email' and status = 'pending';
  insert into audit_events (actor_id, action, target_type, target_id, details)
  values (p_user, 'notify.unsubscribe', 'user', p_user::text, jsonb_build_object('actor', 'service'));
end $$;

-- Test hook for the integration suite (spec 7.12): the cut-off with an explicit clock.
create or replace function public.notify_cutoff_digests(p_now timestamptz default now()) returns int
language sql security definer set search_path = public, app as $$ select app.cutoff_digests(p_now); $$;

-- Wrapper so the Edge Function can claim through PostgREST (public schema only).
create or replace function public.notify_claim_deliveries(p_limit int) returns setof jsonb
language sql security definer set search_path = public, app as $$ select * from app.claim_deliveries(p_limit); $$;

revoke all on function public.notify_digest_users(), public.notify_discount_candidates(uuid, uuid, boolean),
  public.notify_portfolio_candidates(uuid, uuid),
  public.notify_insert_digest(uuid, uuid, digest_kind, jsonb, text, text, text, text, jsonb, jsonb, text),
  public.notify_finish_digests(uuid, text, jsonb), public.notify_active_subscriptions(uuid),
  public.notify_mark_subscription(uuid, text),
  public.notify_complete_delivery(uuid, delivery_status, text, text, text, int, jsonb),
  public.notify_consume_email_quota(uuid, bigint),
  public.notify_record_email_event(text, text, text, text, jsonb), public.notify_unsubscribe(uuid),
  public.notify_claim_deliveries(int), public.notify_cutoff_digests(timestamptz)
  from public, anon, authenticated;
grant execute on function public.notify_digest_users(), public.notify_discount_candidates(uuid, uuid, boolean),
  public.notify_portfolio_candidates(uuid, uuid),
  public.notify_insert_digest(uuid, uuid, digest_kind, jsonb, text, text, text, text, jsonb, jsonb, text),
  public.notify_finish_digests(uuid, text, jsonb), public.notify_active_subscriptions(uuid),
  public.notify_mark_subscription(uuid, text),
  public.notify_complete_delivery(uuid, delivery_status, text, text, text, int, jsonb),
  public.notify_consume_email_quota(uuid, bigint),
  public.notify_record_email_event(text, text, text, text, jsonb), public.notify_unsubscribe(uuid),
  public.notify_claim_deliveries(int), public.notify_cutoff_digests(timestamptz)
  to service_role;
grant execute on function app.cutoff_digests(timestamptz), app.pending_delivery_count(), app.claim_deliveries(int) to service_role;
