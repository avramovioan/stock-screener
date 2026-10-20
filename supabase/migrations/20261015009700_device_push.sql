-- Any device can subscribe to push without an account. Forward-only and replay-safe; nothing that holds data is dropped.
--
-- Subscriptions: user_id becomes optional (an anonymous device), with two topics per device. Existing (signed-in) devices keep
-- receiving what they received before: discounts on, portfolio on.
-- Digests: the user digests are untouched. A public "new companies on the list" digest is stored once per run as a digests row with
-- user_id null (unique per run and kind) and delivered to each active anonymous device that has the discounts topic through
-- digest_deliveries.subscription_id (one row per digest and device, so a device never gets one digest twice). Signed-in devices get
-- the user's own digests, so no device receives both. Retention needs no change: the digest purge deletes the row by age and the
-- deliveries cascade; purged subscriptions take their deliveries with them.

-- 1. Subscriptions ------------------------------------------------------------------------------------------------------------
alter table push_subscriptions alter column user_id drop not null;
alter table push_subscriptions add column if not exists topic_discounts boolean not null default true;
alter table push_subscriptions add column if not exists topic_portfolio boolean not null default false;
update push_subscriptions set topic_portfolio = true where user_id is not null and not topic_portfolio and revoked_at is null;
alter table push_subscriptions drop constraint if exists push_subscriptions_portfolio_needs_user;
alter table push_subscriptions add constraint push_subscriptions_portfolio_needs_user check (not topic_portfolio or user_id is not null);
create index if not exists push_subscriptions_public on push_subscriptions (created_at) where user_id is null and revoked_at is null;
grant select (topic_discounts, topic_portfolio) on push_subscriptions to authenticated;

-- 2. Digests and deliveries -----------------------------------------------------------------------------------------------------
alter table digests alter column user_id drop not null;
alter table digests drop constraint if exists digests_public_is_discounts;
alter table digests add constraint digests_public_is_discounts check (user_id is not null or kind = 'discounts');
create unique index if not exists digests_public_unique on digests (scan_run_id, kind) where user_id is null;

alter table digest_deliveries alter column user_id drop not null;
alter table digest_deliveries add column if not exists subscription_id uuid references push_subscriptions on delete cascade;
alter table digest_deliveries drop constraint if exists digest_deliveries_one_target;
alter table digest_deliveries add constraint digest_deliveries_one_target check (num_nonnulls(user_id, subscription_id) = 1);
create unique index if not exists digest_deliveries_device on digest_deliveries (digest_id, subscription_id) where subscription_id is not null;

-- 3. Candidates: one rule, two entry points -------------------------------------------------------------------------------------
-- app.discount_candidates is the selection of 20261015008900 (new on the list, worldwide). With a user it also applies the user's
-- listing-country filter and the A-13 carry-over (no digest_items row yet); with no user (p_user null) it applies neither.
create or replace function app.discount_candidates(p_scan_run uuid, p_user uuid)
returns table (episode_id uuid, company_id uuid, security_id uuid, mode universe_mode, rank int, yahoo_symbol text,
  name text, close float8, currency text, session_date date, threshold_line text, category text, conclusion text,
  bankruptcy_risk text, summary text, eur_symbol text, eur_status text, is_top10 boolean, reached_line4 boolean, exchange_code text)
language sql stable security definer set search_path = public as $$
  with prev as (
    select r.id
      from scan_runs r
      join scan_runs cur on cur.id = p_scan_run
     where r.results_published_at is not null and r.id <> cur.id and r.scan_date_local < cur.scan_date_local
     order by r.scan_date_local desc
     limit 1
  )
  select t.episode_id, t.company_id, t.security_id, t.mode, t.rank, s.yahoo_symbol, c.name, t.close, t.currency,
         t.session_date, t.threshold_line::text,
         case when done.ok then t.operational_category::text end,
         case when done.ok then t.conclusion end,
         case when done.ok then t.bankruptcy_risk::text end,
         case when done.ok then coalesce(t.research_summary, t.summary, '') else '' end,
         eq.eur_symbol_yahoo, eq.status::text,
         (t.rank <= 10),
         coalesce(t.close <= (t.channel -> 'end' ->> 'lower2')::float8, t.threshold_line = '-4' and t.close <= t.lower_line_end, false),
         s.exchange_code
    from todays_discounts t
    join securities s on s.id = t.security_id
    join exchanges ex on ex.code = s.exchange_code
    join companies c on c.id = t.company_id
    left join notification_preferences p on p.user_id = p_user
    cross join lateral (
      select (coalesce(t.research_report_id, t.report_id) is not null and t.research_completed_at is not null) as ok
    ) done
    left join lateral (
      select q.eur_symbol_yahoo, q.status from eur_equivalents q
       where q.security_id = t.security_id
       order by case q.status when 'verified' then 0 when 'unverified' then 1 else 2 end, (q.ibkr_exchange_id = 'IBIS') desc
       limit 1
    ) eq on true
   where t.scan_run_id = p_scan_run
     and t.mode = 'worldwide'
     and (p_user is null or p.digest_country_filter is null or p.digest_country_filter = coalesce(c.country, ex.country))
     and (t.is_new_episode
          or not exists (select 1 from prev join todays_discounts o on o.scan_run_id = prev.id
                          where o.mode = t.mode and o.security_id = t.security_id))
     and (p_user is null
          or not exists (select 1 from digest_items i where i.user_id = p_user and i.ref_type = 'episode' and i.ref_id = t.episode_id))
   order by t.mode, t.rank, s.yahoo_symbol;
$$;

-- Same signature and result as before: a user without a preferences row still gets nothing.
create or replace function public.notify_discount_candidates(p_scan_run uuid, p_user uuid, p_finished_only boolean)
returns table (episode_id uuid, company_id uuid, security_id uuid, mode universe_mode, rank int, yahoo_symbol text,
  name text, close float8, currency text, session_date date, threshold_line text, category text, conclusion text,
  bankruptcy_risk text, summary text, eur_symbol text, eur_status text, is_top10 boolean, reached_line4 boolean, exchange_code text)
language sql stable security definer set search_path = public, app as $$
  select * from app.discount_candidates(p_scan_run, p_user) c
   where p_user is not null and exists (select 1 from notification_preferences p where p.user_id = p_user)
   order by c.mode, c.rank, c.yahoo_symbol;
$$;

create or replace function public.notify_public_discount_candidates(p_scan_run uuid)
returns table (episode_id uuid, company_id uuid, security_id uuid, mode universe_mode, rank int, yahoo_symbol text,
  name text, close float8, currency text, session_date date, threshold_line text, category text, conclusion text,
  bankruptcy_risk text, summary text, eur_symbol text, eur_status text, is_top10 boolean, reached_line4 boolean, exchange_code text)
language sql stable security definer set search_path = public, app as $$
  select * from app.discount_candidates(p_scan_run, null) c order by c.mode, c.rank, c.yahoo_symbol;
$$;

-- 4. The public digest ---------------------------------------------------------------------------------------------------------------
-- One transaction: the digest row (null when it already exists for the run) and, when it is ready, one pending delivery per active
-- anonymous device with the discounts topic. An empty digest is recorded as skipped and has no deliveries.
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
  end if;
  return v_id;
end $$;

-- 5. Who gets a user digest, and where it goes ----------------------------------------------------------------------------------------
-- Appends has_discounts_push / has_portfolio_push (an active device of the user with that topic); the rest is as before.
drop function if exists public.notify_digest_users();
create function public.notify_digest_users() returns table (
  user_id uuid, push_enabled boolean, email_enabled boolean, email_ok boolean, has_active_push boolean,
  digest_modes universe_mode[], send_empty boolean, holds_positions boolean, has_discounts_push boolean, has_portfolio_push boolean)
language plpgsql security definer set search_path = public, auth as $$
declare v_holds text := case when to_regclass('public.broker_positions') is not null
  then 'exists (select 1 from broker_positions b where b.user_id = p.user_id)' else 'false' end;
begin
  return query execute format($q$
    select p.user_id, p.push_enabled, p.email_enabled,
           (a.email_confirmed_at is not null and p.email_unsubscribed_at is null and p.email_bounced_at is null),
           exists (select 1 from push_subscriptions s where s.user_id = p.user_id and s.revoked_at is null),
           p.digest_modes, p.send_empty, %s,
           exists (select 1 from push_subscriptions s where s.user_id = p.user_id and s.revoked_at is null and s.topic_discounts),
           exists (select 1 from push_subscriptions s where s.user_id = p.user_id and s.revoked_at is null and s.topic_portfolio)
      from notification_preferences p join auth.users a on a.id = p.user_id
     where p.push_enabled or p.email_enabled
     order by p.user_id$q$, v_holds);
end $$;

-- A user's devices for one digest kind (null = all of them): the topic of the kind must be on.
drop function if exists public.notify_active_subscriptions(uuid);
create function public.notify_active_subscriptions(p_user uuid, p_kind text default null)
returns table (id uuid, endpoint text, p256dh text, auth text)
language sql stable security definer set search_path = public as $$
  select s.id, s.endpoint, s.p256dh, s.auth from push_subscriptions s
   where s.user_id = p_user and s.revoked_at is null
     and (p_kind is null or (p_kind = 'discounts' and s.topic_discounts) or (p_kind = 'portfolio' and s.topic_portfolio))
   order by s.created_at;
$$;

-- The device behind a public delivery: still active, still anonymous (a device that signed in gets the user digest instead) and
-- still opted in to discounts.
create or replace function public.notify_device_subscription(p_id uuid)
returns table (id uuid, endpoint text, p256dh text, auth text)
language sql stable security definer set search_path = public as $$
  select s.id, s.endpoint, s.p256dh, s.auth from push_subscriptions s
   where s.id = p_id and s.user_id is null and s.revoked_at is null and s.topic_discounts;
$$;

-- Claim: as before, plus the subscription id of a device delivery. A device delivery has no user and no preferences row, so its
-- prefs say push is on (the topic and the subscription state are checked when it is sent).
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
    'id', u.id, 'digestId', u.digest_id, 'userId', u.user_id, 'subscriptionId', u.subscription_id,
    'channel', u.channel, 'attempts', u.attempts,
    'idempotencyKey', u.idempotency_key, 'quotaConsumed', u.quota_consumed,
    'kind', g.kind, 'content', g.content, 'scanRunId', g.scan_run_id, 'digestCreatedAt', g.created_at,
    'scanDate', s.scan_date_local,
    'prefs', jsonb_build_object(
      'pushEnabled', (u.subscription_id is not null) or coalesce(p.push_enabled, false),
      'emailEnabled', coalesce(p.email_enabled, false),
      'emailUnsubscribedAt', p.email_unsubscribed_at, 'emailBouncedAt', p.email_bounced_at,
      'emailConfirmed', (a.email_confirmed_at is not null)),
    'email', case when u.channel = 'email' then a.email end)
  from upd u
  join digests g on g.id = u.digest_id
  join scan_runs s on s.id = g.scan_run_id
  left join notification_preferences p on p.user_id = u.user_id
  left join auth.users a on a.id = u.user_id;
end $$;

-- 6. Subscribe, update, test --------------------------------------------------------------------------------------------------------
-- p_user null = an anonymous device (no per-user cap, portfolio forced off). A known endpoint is re-bound to p_user (or to nobody)
-- and revived. A signed-in subscribe also turns the user's digest push on, so the user digest is built for the user.
drop function if exists public.notify_subscribe(uuid, text, text, text, text, int);
create function public.notify_subscribe(
  p_user uuid, p_endpoint text, p_p256dh text, p_auth text, p_user_agent text, p_max int,
  p_discounts boolean default true, p_portfolio boolean default false) returns text
language plpgsql security definer set search_path = public as $$
declare v_count int; v_portfolio boolean := coalesce(p_portfolio, false) and p_user is not null;
begin
  if p_user is not null then
    perform pg_advisory_xact_lock(hashtextextended('notify_subscribe:' || p_user::text, 0));
    select count(*) into v_count from push_subscriptions
     where user_id = p_user and revoked_at is null and endpoint <> p_endpoint;
    if v_count >= p_max then return 'too_many'; end if;
  end if;
  insert into push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, topic_discounts, topic_portfolio)
  values (p_user, p_endpoint, p_p256dh, p_auth, p_user_agent, coalesce(p_discounts, true), v_portfolio)
  on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
    user_agent = excluded.user_agent, topic_discounts = excluded.topic_discounts, topic_portfolio = excluded.topic_portfolio,
    revoked_at = null, revoke_reason = null, failure_count = 0;
  if p_user is not null then
    insert into notification_preferences (user_id, push_enabled) values (p_user, true)
    on conflict (user_id) do update set push_enabled = true;
  end if;
  return 'ok';
end $$;

-- Re-binds an active subscription and sets its topics; false when no active row has that endpoint.
create or replace function public.notify_update_subscription(p_user uuid, p_endpoint text, p_discounts boolean, p_portfolio boolean)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  update push_subscriptions
     set user_id = p_user, topic_discounts = coalesce(p_discounts, true), topic_portfolio = coalesce(p_portfolio, false) and p_user is not null
   where endpoint = p_endpoint and revoked_at is null;
  get diagnostics v_n = row_count;
  if v_n = 0 then return false; end if;
  if p_user is not null then
    insert into notification_preferences (user_id, push_enabled) values (p_user, true)
    on conflict (user_id) do update set push_enabled = true;
  end if;
  return true;
end $$;

-- One test push per endpoint per minute. status: ok (with the target) | rate_limited | not_found.
create or replace function public.notify_claim_endpoint_test(p_endpoint text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r push_subscriptions%rowtype;
begin
  select * into r from push_subscriptions where endpoint = p_endpoint and revoked_at is null for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if r.last_test_at is not null and r.last_test_at > now() - interval '1 minute' then
    return jsonb_build_object('status', 'rate_limited');
  end if;
  update push_subscriptions set last_test_at = now() where id = r.id;
  return jsonb_build_object('status', 'ok', 'id', r.id, 'endpoint', r.endpoint, 'p256dh', r.p256dh, 'auth', r.auth);
end $$;

-- Grants: service role only, like every notify_ function --------------------------------------------------------------------------------
revoke all on function app.discount_candidates(uuid, uuid), app.claim_deliveries(int) from public, anon, authenticated;
grant execute on function app.discount_candidates(uuid, uuid), app.claim_deliveries(int) to service_role;
revoke all on function public.notify_discount_candidates(uuid, uuid, boolean), public.notify_public_discount_candidates(uuid),
  public.notify_insert_public_digest(uuid, jsonb, text, text, text, text, text), public.notify_digest_users(),
  public.notify_active_subscriptions(uuid, text), public.notify_device_subscription(uuid),
  public.notify_subscribe(uuid, text, text, text, text, int, boolean, boolean),
  public.notify_update_subscription(uuid, text, boolean, boolean), public.notify_claim_endpoint_test(text)
  from public, anon, authenticated;
grant execute on function public.notify_discount_candidates(uuid, uuid, boolean), public.notify_public_discount_candidates(uuid),
  public.notify_insert_public_digest(uuid, jsonb, text, text, text, text, text), public.notify_digest_users(),
  public.notify_active_subscriptions(uuid, text), public.notify_device_subscription(uuid),
  public.notify_subscribe(uuid, text, text, text, text, int, boolean, boolean),
  public.notify_update_subscription(uuid, text, boolean, boolean), public.notify_claim_endpoint_test(text)
  to service_role;
