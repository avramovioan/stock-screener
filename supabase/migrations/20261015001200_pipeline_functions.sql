-- P1 / migration 3 of 4: pipeline SQL functions, public read functions, views, RLS, grants.
-- Spec sections 6.6, 6.7, 6.8, 6.9, 7.2, 7.3, 7.6. Deviations are noted inline and listed in the plan.

create extension if not exists supabase_vault;             -- Vault holds project_url and worker_tick_secret (6.7)

-- ------------------------------------------------------------------ schema app: callable by service_role only
revoke all on schema app from public, anon, authenticated;
grant usage on schema app to service_role;
alter default privileges in schema app grant execute on functions to service_role;
-- PUBLIC keeps EXECUTE on new functions by the global default, so the lock-down is an explicit statement at the END of this
-- migration (and of every later migration that adds app functions).

-- ------------------------------------------------------------------ helpers
-- Deviation: the spec places is_admin() in schema app, but P0's pgTAP smoke test pins that `authenticated` has no USAGE on app.
-- RLS policies run with the caller's privileges, so the helper lives in public (SECURITY DEFINER, pinned search_path, no arguments).
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select p.is_admin from profiles p where p.user_id = auth.uid()), false)
$$;
revoke execute on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

create or replace function app.current_settings_snapshot() returns jsonb
language sql stable security definer set search_path = public, app as $$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from app_settings where key in ('indicator', 'universe', 'pipeline')
$$;

create or replace function app.record_event(
  p_run uuid, p_event text, p_level text default 'info', p_stage text default null, p_job bigint default null,
  p_security uuid default null, p_message text default null, p_data jsonb default null
) returns void language sql security definer set search_path = public, app as $$
  insert into scan_events (scan_run_id, job_id, stage, level, event, security_id, message, data)
  values (p_run, p_job, p_stage::job_stage, p_level, p_event, p_security, p_message, p_data)
$$;

-- ------------------------------------------------------------------ 6.6.3 minute tick (P1 part: worker-tick only)
-- Later phases extend this function with notify-dispatch and broker-sync (CREATE OR REPLACE).
-- Deviation: timeout_milliseconds 145000 as in the spec (worker-tick answers 202 at once via EdgeRuntime.waitUntil, so the
-- long timeout costs nothing and protects against a platform that cancels on client disconnect, which is UNVERIFIED, Q-02).
create or replace function app.kick_workers() returns void
language plpgsql security definer set search_path = public, app, vault, net as $$
declare v_url text; v_secret text; v_hdr jsonb;
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
end $$;

-- ------------------------------------------------------------------ 6.6.1 daily start
-- Extra parameter p_snapshot_extra is merged into settings_snapshot (fixture runs carry provider_mode = 'fixture', 7.12).
-- Only the fx job is seeded here; every later stage is seeded by app.next_stage_to_seed (7.4), because the universe sweep needs the FX rows.
create or replace function app.start_daily_scan(
  p_now timestamptz default now(), p_force boolean default false, p_trigger text default 'cron', p_snapshot_extra jsonb default '{}'::jsonb
) returns uuid language plpgsql security definer set search_path = public, app as $$
declare v_date date := (p_now at time zone 'Europe/Sofia')::date; v_id uuid;
begin
  -- DST-safe guard: only the 07:00 UTC entry (summer, UTC+3) or the 08:00 UTC entry (winter, UTC+2) passes (7.2)
  if not p_force and extract(hour from (p_now at time zone 'Europe/Sofia')) <> 10 then
    return null;
  end if;
  insert into scan_runs (scan_date_local, status, trigger, started_at, settings_snapshot, digest_cutoff_at)
  values (v_date, 'queued', p_trigger, p_now, app.current_settings_snapshot() || coalesce(p_snapshot_extra, '{}'::jsonb),
          ((v_date + time '13:00') at time zone 'Europe/Sofia'))
  on conflict (scan_date_local) do nothing
  returning id into v_id;
  if v_id is null then return null; end if;                 -- already started today: idempotent no-op
  insert into scan_jobs (scan_run_id, stage, key, priority) values (v_id, 'fx', 'all', 10) on conflict do nothing;
  insert into scan_events (scan_run_id, level, event, data)
  values (v_id, 'info', 'scan_started', jsonb_build_object('scan_date_local', v_date, 'trigger', p_trigger));
  perform app.kick_workers();
  return v_id;
end $$;

-- Catch-up: if the Sofia hour is 10-12 and no run exists for today, start one. p_now makes it replayable in pgTAP.
create or replace function app.ensure_scan_today(p_now timestamptz default now()) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare v_hour int := extract(hour from (p_now at time zone 'Europe/Sofia'));
begin
  if v_hour between 10 and 12
     and not exists (select 1 from scan_runs where scan_date_local = (p_now at time zone 'Europe/Sofia')::date) then
    return app.start_daily_scan(p_now, true, 'cron_catchup');
  end if;
  return null;
end $$;

-- ------------------------------------------------------------------ 6.6.2 job claim with leases
create or replace function app.reap_expired_leases() returns int
language plpgsql security definer set search_path = public, app as $$
declare n int;
begin
  with x as (
    update scan_jobs
       set status = case when attempts >= max_attempts then 'dead'::job_status else 'queued'::job_status end,
           lease_until = null, leased_by = null,
           not_before = now() + interval '30 seconds',
           last_error = coalesce(last_error, 'lease_expired'),
           finished_at = case when attempts >= max_attempts then now() else finished_at end
     where status = 'leased' and lease_until < now()
    returning 1)
  select count(*) into n from x;
  return n;
end $$;

create or replace function app.claim_jobs(
  p_worker text, p_limit int, p_lease interval, p_stages job_stage[], p_stage_limits jsonb default '{}'::jsonb
) returns setof scan_jobs language plpgsql security definer set search_path = public, app as $$
declare r scan_jobs; n int := 0; lim int;
begin
  perform app.reap_expired_leases();
  for r in
    select j.* from scan_jobs j
     where j.status in ('queued', 'failed') and j.not_before <= now() and j.stage = any (p_stages)
     order by j.priority, j.id
     for update skip locked
  loop
    exit when n >= p_limit;
    perform pg_advisory_xact_lock(hashtext('stage:' || r.stage::text));            -- serialise the per-stage cap check
    lim := coalesce((p_stage_limits ->> r.stage::text)::int, 1000);
    continue when (select count(*) from scan_jobs x where x.stage = r.stage and x.status = 'leased' and x.lease_until > now()) >= lim;
    update scan_jobs
       set status = 'leased', leased_by = p_worker, lease_until = now() + p_lease,
           attempts = attempts + 1, started_at = coalesce(started_at, now())
     where id = r.id
    returning * into r;
    update scan_runs
       set status = case when status = 'queued' then 'running'::scan_status else status end, last_heartbeat_at = now()
     where id = r.scan_run_id;
    return next r;
    n := n + 1;
  end loop;
end $$;

create or replace function app.complete_job(p_id bigint, p_result jsonb default null) returns void
language sql security definer set search_path = public, app as $$
  update scan_jobs set status = 'done', result = p_result, finished_at = now(), lease_until = null
   where id = p_id and status = 'leased'
$$;

-- Failed attempt: retry with backoff 1m, 2m, 4m, 8m (+ up to 25% jitter) and dead at max_attempts, or dead at once when fatal.
create or replace function app.fail_job(p_id bigint, p_error text, p_retry_in interval default null, p_fatal boolean default false)
returns job_status language plpgsql security definer set search_path = public, app as $$
declare r scan_jobs; v_status job_status; v_delay interval;
begin
  select * into r from scan_jobs where id = p_id for update;
  if not found then return null; end if;
  if p_fatal or r.attempts >= r.max_attempts then
    v_status := 'dead';
  else
    v_status := 'failed';
    v_delay := coalesce(p_retry_in, make_interval(secs => 60 * power(2, greatest(r.attempts - 1, 0)) * (1 + random() * 0.25)));
  end if;
  update scan_jobs
     set status = v_status, last_error = left(p_error, 2000), lease_until = null, leased_by = null,
         finished_at = case when v_status = 'dead' then now() else finished_at end,
         not_before = case when v_status = 'failed' then now() + v_delay else not_before end
   where id = p_id;
  return v_status;
end $$;

-- Reschedules a leased job WITHOUT consuming an attempt (breaker open, waiting for sibling jobs; 7.9).
create or replace function app.defer_job(p_id bigint, p_delay interval, p_reason text default null) returns void
language sql security definer set search_path = public, app as $$
  update scan_jobs
     set status = 'queued', not_before = now() + p_delay, lease_until = null, leased_by = null,
         attempts = greatest(attempts - 1, 0), last_error = p_reason
   where id = p_id and status = 'leased'
$$;

create or replace function app.heartbeat_job(p_id bigint, p_extend interval) returns void
language sql security definer set search_path = public, app as $$
  update scan_jobs set lease_until = now() + p_extend where id = p_id and status = 'leased'
$$;

-- Stage seeding. p_payloads is a JSON array aligned with p_keys (PostgREST passes it as jsonb), p_priorities likewise.
-- Zero keys inserts a done marker (_empty) so the pipeline can move on. Idempotent: ON CONFLICT DO NOTHING.
create or replace function app.seed_stage(
  p_run uuid, p_stage text, p_keys text[], p_payloads jsonb default null, p_priorities int[] default null
) returns int language plpgsql security definer set search_path = public, app as $$
declare v_n int;
begin
  if coalesce(array_length(p_keys, 1), 0) = 0 then
    insert into scan_jobs (scan_run_id, stage, key, status, finished_at, result)
    values (p_run, p_stage::job_stage, '_empty', 'done', now(), '{"skipped":true}')
    on conflict (scan_run_id, stage, key) do nothing;
    return 0;
  end if;
  with ins as (
    insert into scan_jobs (scan_run_id, stage, key, payload, priority)
    select p_run, p_stage::job_stage, k.key,
           coalesce(case when p_payloads is not null and jsonb_typeof(p_payloads) = 'array' then p_payloads -> (k.ord::int - 1) end, '{}'::jsonb),
           coalesce(p_priorities[k.ord::int], 100)
      from unnest(p_keys) with ordinality as k(key, ord)
    on conflict (scan_run_id, stage, key) do nothing
    returning 1)
  select count(*) into v_n from ins;
  return v_n;
end $$;

-- First stage in pipeline order that has no jobs yet and whose predecessor is fully terminal; null when nothing can be seeded now.
-- A dead job in a critical stage (fx, rank_signals) stops the pipeline. Later phases CREATE OR REPLACE this function with more stages.
create or replace function app.next_stage_to_seed(p_run uuid) returns job_stage
language plpgsql stable security definer set search_path = public, app as $$
declare
  v_order job_stage[] := array['fx','universe_sweep','identity','fetch_bars','compute','rank_signals','classify','publish']::job_stage[];
  i int; v_stage job_stage; v_prev job_stage; v_cnt int; v_open int; v_dead int;
begin
  for i in 1 .. array_length(v_order, 1) loop
    v_stage := v_order[i];
    select count(*) into v_cnt from scan_jobs where scan_run_id = p_run and stage = v_stage;
    if v_cnt = 0 then
      if i = 1 then return v_stage; end if;
      v_prev := v_order[i - 1];
      select count(*) filter (where status in ('queued', 'leased', 'failed')), count(*) filter (where status = 'dead')
        into v_open, v_dead from scan_jobs where scan_run_id = p_run and stage = v_prev;
      if v_open > 0 then return null; end if;
      if v_prev in ('fx', 'rank_signals') and v_dead > 0 then return null; end if;
      return v_stage;
    end if;
  end loop;
  return null;
end $$;

-- ------------------------------------------------------------------ 7.6 status model
create or replace function app.refresh_scan_status(p_run uuid) returns scan_status
language plpgsql security definer set search_path = public, app as $$
declare
  r scan_runs; v_total int; v_open int; v_dead int; v_crit_dead int; v_started boolean; v_more boolean; v_rank_done boolean;
  v_gap int; v_status scan_status; v_hard timestamptz; v_terminal boolean; v_now timestamptz;
begin
  select * into r from scan_runs where id = p_run for update;
  if not found then return null; end if;
  v_hard := (r.scan_date_local + time '22:00') at time zone 'Europe/Sofia';        -- hard deadline (A-15)
  -- a fixture run replays a simulated date: its deadlines are judged one hour after its own start, never against the real clock (7.12)
  v_now := case when r.settings_snapshot ->> 'provider_mode' = 'fixture' then r.started_at + interval '1 hour' else now() end;
  if v_now >= v_hard then
    update scan_jobs set status = 'dead', last_error = 'deadline', lease_until = null, leased_by = null, finished_at = now()
     where scan_run_id = p_run and status in ('queued', 'leased', 'failed');
  end if;
  select count(*),
         count(*) filter (where status in ('queued', 'leased', 'failed')),
         count(*) filter (where status = 'dead'),
         count(*) filter (where status = 'dead' and stage in ('fx', 'rank_signals')),
         coalesce(bool_or(attempts > 0 or status in ('done', 'dead')), false)
    into v_total, v_open, v_dead, v_crit_dead, v_started
    from scan_jobs where scan_run_id = p_run;
  v_more := app.next_stage_to_seed(p_run) is not null;
  v_rank_done := exists (select 1 from scan_jobs where scan_run_id = p_run and stage = 'rank_signals' and status = 'done');
  v_gap := coalesce((r.coverage -> 'candidates' ->> 'failed')::int, 0) + coalesce((r.coverage -> 'candidates' ->> 'unprocessed')::int, 0)
         + coalesce((r.coverage -> 'candidates' ->> 'stale')::int, 0) + coalesce((r.coverage -> 'candidates' ->> 'carried_forward')::int, 0);
  v_terminal := v_total > 0 and v_open = 0 and not v_more;

  if v_crit_dead > 0 or (v_now >= v_hard and not v_rank_done) then
    v_status := 'failed';
  elsif not v_terminal then
    if r.digest_cutoff_at is not null and v_now >= r.digest_cutoff_at then v_status := 'partial';       -- soft deadline (13:00 Sofia)
    elsif v_started then v_status := 'running';
    else v_status := 'queued';
    end if;
  elsif v_dead > 0 or v_gap > 0 then
    v_status := 'partial';
  else
    v_status := 'complete';
  end if;

  update scan_runs
     set status = v_status,
         finished_at = case when v_status = 'failed' or (v_terminal and v_status in ('complete', 'partial')) then coalesce(finished_at, now()) else null end,
         last_heartbeat_at = now()
   where id = p_run;
  if v_status is distinct from r.status then
    insert into scan_events (scan_run_id, level, event, data)
    values (p_run, case when v_status in ('failed', 'partial') then 'warn' else 'info' end, 'scan_status_changed',
            jsonb_build_object('from', r.status, 'to', v_status));
  end if;
  return v_status;
end $$;

-- ------------------------------------------------------------------ 6.4 retention (P1 tables), batched and idempotent
create or replace function app.purge_expired(p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare v_jobs int := 0; v_events int := 0; v_cache int := 0; v_membership int := 0; n int;
begin
  loop
    delete from scan_events where id in (select id from scan_events where at < p_now - interval '30 days' limit 5000);
    get diagnostics n = row_count; v_events := v_events + n; exit when n = 0;
  end loop;
  loop   -- only terminal jobs: a queued or leased job is never purged
    delete from scan_jobs where id in (select id from scan_jobs where created_at < p_now - interval '30 days' and status in ('done', 'dead') limit 5000);
    get diagnostics n = row_count; v_jobs := v_jobs + n; exit when n = 0;
  end loop;
  loop
    delete from quote_cache where key in (select key from quote_cache where expires_at < p_now or fetched_at < p_now - interval '1 day' limit 5000);
    get diagnostics n = row_count; v_cache := v_cache + n; exit when n = 0;
  end loop;
  loop
    delete from universe_membership_events where id in (
      select id from universe_membership_events where event_date < (p_now at time zone 'Europe/Sofia')::date - 90 limit 5000);
    get diagnostics n = row_count; v_membership := v_membership + n; exit when n = 0;
  end loop;
  return jsonb_build_object('scan_events', v_events, 'scan_jobs', v_jobs, 'quote_cache', v_cache, 'universe_membership_events', v_membership);
end $$;

-- ------------------------------------------------------------------ data-application functions used by the stage handlers
-- Bulk, transactional and idempotent: one round trip per batch instead of one per security.

-- Securities seen by the universe sweep / recheck / quote enrichment: creates companies and securities that do not exist yet
-- (every new security starts in its own provisional company; identity:group merges them), refreshes the mutable fields of the
-- known ones (never nulling a known value), and upserts the market-cap snapshot of the run.
-- Each element of p_rows: yahoo_symbol, new_company_id, name, name_normalized, exchange_code, currency, currency_major, minor_divisor,
-- quote_type, long_name, financial_currency, shares_outstanding, first_trade_date, market_cap_native, fx_usd_per_unit, fx_rate_date,
-- fx_source, market_cap_usd, price_time, source ('yahoo_screener' | 'yahoo_quote'), quality ('ok' | 'stale' | 'missing' | 'fx_missing').
create or replace function app.apply_quote_rows(p_run uuid, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare v_created int; v_updated int; v_snapshots int; v_skipped int;
begin
  create temp table _rows on commit drop as
  select * from jsonb_to_recordset(p_rows) as r(
    yahoo_symbol text, new_company_id uuid, name text, name_normalized text, exchange_code text, currency text, currency_major text,
    minor_divisor int, quote_type text, long_name text, financial_currency text, shares_outstanding bigint, first_trade_date date,
    market_cap_native float8, fx_usd_per_unit float8, fx_rate_date date, fx_source text, market_cap_usd float8, price_time timestamptz,
    source text, quality text);
  select count(*) into v_skipped from _rows r where not exists (select 1 from exchanges e where e.code = r.exchange_code);
  delete from _rows r where not exists (select 1 from exchanges e where e.code = r.exchange_code);

  -- new securities (and their provisional companies)
  insert into companies (id, name, name_normalized)
  select r.new_company_id, r.name, r.name_normalized from _rows r
   where not exists (select 1 from securities s where s.yahoo_symbol = r.yahoo_symbol);
  insert into securities (company_id, yahoo_symbol, exchange_code, currency, currency_major, minor_divisor, quote_type, long_name,
                          financial_currency, shares_outstanding, first_trade_date)
  select r.new_company_id, r.yahoo_symbol, r.exchange_code, r.currency, r.currency_major, r.minor_divisor, r.quote_type, r.long_name,
         r.financial_currency, r.shares_outstanding, r.first_trade_date
    from _rows r where not exists (select 1 from securities s where s.yahoo_symbol = r.yahoo_symbol);
  get diagnostics v_created = row_count;

  -- known securities: refresh mutable fields (a missing value never overwrites a known one); the rows just created are untouched
  update securities s
     set exchange_code = r.exchange_code, currency = r.currency, currency_major = r.currency_major, minor_divisor = r.minor_divisor,
         quote_type = r.quote_type, long_name = coalesce(r.long_name, s.long_name), financial_currency = coalesce(r.financial_currency, s.financial_currency),
         shares_outstanding = coalesce(r.shares_outstanding, s.shares_outstanding), first_trade_date = coalesce(r.first_trade_date, s.first_trade_date),
         status = 'active', missing_scans = 0
    from _rows r
   where s.yahoo_symbol = r.yahoo_symbol and s.company_id is distinct from r.new_company_id;
  get diagnostics v_updated = row_count;

  insert into market_cap_snapshots (scan_run_id, security_id, market_cap_native, currency_major, fx_usd_per_unit, fx_rate_date, fx_source,
                                    market_cap_usd, shares_outstanding, price_time, source, quality)
  select p_run, s.id, r.market_cap_native, r.currency_major, r.fx_usd_per_unit, r.fx_rate_date, r.fx_source, r.market_cap_usd,
         r.shares_outstanding, r.price_time, r.source, r.quality
    from _rows r join securities s on s.yahoo_symbol = r.yahoo_symbol
  on conflict (scan_run_id, security_id) do update
     set market_cap_native = excluded.market_cap_native, currency_major = excluded.currency_major, fx_usd_per_unit = excluded.fx_usd_per_unit,
         fx_rate_date = excluded.fx_rate_date, fx_source = excluded.fx_source, market_cap_usd = excluded.market_cap_usd,
         shares_outstanding = excluded.shares_outstanding, price_time = excluded.price_time, source = excluded.source, quality = excluded.quality;
  get diagnostics v_snapshots = row_count;
  drop table _rows;
  return jsonb_build_object('created', v_created, 'updated', v_updated, 'snapshots', v_snapshots, 'skipped_unknown_exchange', v_skipped);
end $$;

-- Identity grouping result. Each element of p_groups: company_id (the surviving company), member_ids (uuid[]), canonical_id (uuid or null),
-- roles ({security_id: role}), country, name, name_normalized. Members move into the surviving company, roles and the canonical flag are
-- set (previous canonical flags are cleared first because of the one-canonical-per-company index), and companies left without securities
-- are deleted, or marked inactive when an old snapshot, episode or card still references them.
create or replace function app.apply_identity_groups(p_groups jsonb) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare g jsonb; v_members uuid[]; v_canonical uuid; v_groups int := 0; v_deleted int := 0; v_deactivated int := 0; o record;
begin
  for g in select * from jsonb_array_elements(p_groups) loop
    select array_agg(x::uuid) into v_members from jsonb_array_elements_text(g -> 'member_ids') x;
    v_canonical := nullif(g ->> 'canonical_id', '')::uuid;
    insert into companies (id, name, name_normalized)
    values ((g ->> 'company_id')::uuid, coalesce(g ->> 'name', 'unknown'), coalesce(g ->> 'name_normalized', 'unknown'))
    on conflict (id) do nothing;
    update securities set is_canonical = false where id = any (v_members) and is_canonical;
    update securities s
       set company_id = (g ->> 'company_id')::uuid, role = coalesce(g -> 'roles' ->> s.id::text, 'other'), is_canonical = false
     where s.id = any (v_members);
    if v_canonical is not null then
      update securities set is_canonical = true, role = 'canonical' where id = v_canonical;
    end if;
    update companies
       set canonical_security_id = v_canonical, country = coalesce(g ->> 'country', country), name = coalesce(g ->> 'name', name),
           name_normalized = coalesce(g ->> 'name_normalized', name_normalized), status = 'active'
     where id = (g ->> 'company_id')::uuid;
    v_groups := v_groups + 1;
  end loop;

  for o in select c.id from companies c where c.status = 'active' and not exists (select 1 from securities s where s.company_id = c.id) loop
    begin
      delete from companies where id = o.id;
      v_deleted := v_deleted + 1;
    exception when foreign_key_violation then
      update companies set status = 'inactive', canonical_security_id = null where id = o.id;
      v_deactivated := v_deactivated + 1;
    end;
  end loop;
  return jsonb_build_object('groups', v_groups, 'orphans_deleted', v_deleted, 'orphans_deactivated', v_deactivated);
end $$;

-- Database size for the health function (alarm at 400 MB of the 500 MB Free limit, 16.5).
create or replace function app.database_size() returns bigint language sql stable security definer set search_path = public, app as $$
  select pg_database_size(current_database())
$$;

-- ------------------------------------------------------------------ 6.6.4 public read functions
-- Company List: first page 15 rows; stable keyset pagination on rank.
-- Deviation: SECURITY DEFINER (spec: invoker), because it reads market_cap_snapshots, which anon must not read directly (6.9).
create or replace function public.company_list(p_mode universe_mode, p_limit int default 15, p_after_rank int default null)
returns table (rank int, company_id uuid, security_id uuid, yahoo_symbol text, name text, currency text,
               last_close float8, prev_close float8, change_pct float8, session_date date, price_freshness freshness_status,
               market_cap_usd float8, market_cap_native float8, market_cap_ccy text,
               is_top10 boolean, applicable_line threshold_line, lower_line_positive boolean, is_discount boolean,
               state text, total_count bigint)
language sql stable security definer set search_path = public as $$
  with run as (select id from scan_runs where list_published_at is not null order by scan_date_local desc limit 1),
  base as (
    select u.*, count(*) over () as total_count
      from universe_snapshots u join run on u.scan_run_id = run.id
     where u.mode = p_mode and u.rank > coalesce(p_after_rank, 0)
     order by u.rank limit least(greatest(p_limit, 1), 100))
  select b.rank, b.company_id, b.security_id, s.yahoo_symbol, c.name, s.currency,
         ps.last_close, ps.prev_close,
         case when ps.prev_close > 0 then (ps.last_close / ps.prev_close - 1) * 100 end,
         ps.last_session_date, ps.freshness, b.market_cap_usd,
         mc.market_cap_native, mc.currency_major, b.is_top10, b.applicable_line, b.lower_line_positive, b.is_discount, b.state, b.total_count
    from base b
    join securities s on s.id = b.security_id
    join companies c on c.id = b.company_id
    left join price_series ps on ps.security_id = b.security_id
    left join lateral (select m.market_cap_native, m.currency_major from market_cap_snapshots m
                        where m.security_id = b.security_id order by m.id desc limit 1) mc on true
   order by b.rank
$$;

-- The short summary: added/removed today and over the trailing seven days (distinct companies, most recent event date).
create or replace function public.universe_summary(p_mode universe_mode) returns jsonb
language sql stable security invoker set search_path = public as $$
  with latest as (select id, scan_date_local from scan_runs where list_published_at is not null order by scan_date_local desc limit 1),
  ev as (
    select e.event, e.company_id, c.name, max(e.event_date) as last_date, bool_or(e.scan_run_id = (select id from latest)) as today
      from universe_membership_events e join companies c on c.id = e.company_id, latest
     where e.mode = p_mode and e.event_date >= latest.scan_date_local - 6
     group by e.event, e.company_id, c.name)
  select jsonb_build_object(
    'as_of', (select scan_date_local from latest),
    'added_today',   coalesce((select jsonb_agg(jsonb_build_object('company_id', company_id, 'name', name) order by name) from ev where event = 'added'   and today), '[]'),
    'removed_today', coalesce((select jsonb_agg(jsonb_build_object('company_id', company_id, 'name', name) order by name) from ev where event = 'removed' and today), '[]'),
    'added_7d',      coalesce((select jsonb_agg(jsonb_build_object('company_id', company_id, 'name', name, 'date', last_date) order by last_date desc, name) from ev where event = 'added'), '[]'),
    'removed_7d',    coalesce((select jsonb_agg(jsonb_build_object('company_id', company_id, 'name', name, 'date', last_date) order by last_date desc, name) from ev where event = 'removed'), '[]'))
$$;

-- Scan status for the public header: three separate timestamps, never inferred from an attempt.
create or replace function public.scan_status() returns jsonb language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'last_attempted', (select to_jsonb(r) from (select scan_date_local, started_at, status from scan_runs order by started_at desc limit 1) r),
    'last_successful', (select to_jsonb(r) from (select scan_date_local, finished_at from scan_runs where status = 'complete' order by finished_at desc limit 1) r),
    'latest_published', (select to_jsonb(r) from (select scan_date_local, status, latest_session_date, coverage, results_published_at, list_published_at
                                                     from scan_runs where results_published_at is not null order by scan_date_local desc limit 1) r))
$$;

-- ONE security per call; the arrays are not selectable directly (A-41).
create or replace function public.get_price_series(p_security_id uuid) returns price_series
language sql stable security definer set search_path = public as $$ select * from price_series where security_id = p_security_id $$;

-- The public overview view (cards and withheld panel). P1 has no eur_equivalents table yet: the EUR columns are typed nulls
-- and are replaced by the real join in P2 (CREATE OR REPLACE VIEW keeps the column list).
create or replace view public.v_todays_discounts with (security_invoker = true) as
select t.scan_run_id, t.mode, t.rank, t.display_order, t.withheld, s.id as security_id, s.yahoo_symbol, c.name, ex.code as exchange_code, ex.name as exchange_name,
       t.close, t.currency, t.session_date, t.threshold_line, t.lower_line_end, t.data_freshness, t.is_new_episode, e.opened_session_date as since_date,
       t.operational_category, t.category_reason, t.conclusion, t.bankruptcy_risk, t.summary, t.research_completed_at, t.report_id,
       null::text as eur_symbol_yahoo, null::text as ibkr_local_symbol, null::text as ibkr_exchange_id, null::text as eur_status, null::timestamptz as eur_verified_at
  from todays_discounts t
  join securities s on s.id = t.security_id
  join companies c on c.id = t.company_id
  join exchanges ex on ex.code = s.exchange_code
  join signal_episodes e on e.id = t.episode_id
 where t.scan_run_id = (select id from scan_runs where results_published_at is not null order by scan_date_local desc limit 1);

create or replace function public.todays_discounts_feed(p_mode universe_mode) returns setof public.v_todays_discounts
language sql stable security invoker set search_path = public as $$
  select * from public.v_todays_discounts where mode = p_mode
   order by withheld, case operational_category when 'green' then 0 when 'amber' then 1 else 2 end, display_order
$$;

-- ------------------------------------------------------------------ 6.8 / 6.9 grants and RLS (every table is locked down first)
revoke all on profiles, exchanges, fx_rates, companies, securities, security_identity_overrides, price_series, market_cap_snapshots,
              quote_cache, app_settings, audit_events, scan_runs, scan_jobs, scan_events, scan_security_results, universe_snapshots,
              universe_membership_events, signal_episodes, todays_discounts
  from anon, authenticated;

alter table profiles                   enable row level security;
alter table exchanges                  enable row level security;
alter table fx_rates                   enable row level security;
alter table companies                  enable row level security;
alter table securities                 enable row level security;
alter table security_identity_overrides enable row level security;
alter table price_series               enable row level security;
alter table market_cap_snapshots       enable row level security;
alter table quote_cache                enable row level security;
alter table app_settings               enable row level security;
alter table audit_events               enable row level security;
alter table scan_runs                  enable row level security;
alter table scan_jobs                  enable row level security;
alter table scan_events                enable row level security;
alter table scan_security_results      enable row level security;
alter table universe_snapshots         enable row level security;
alter table universe_membership_events enable row level security;
alter table signal_episodes            enable row level security;
alter table todays_discounts           enable row level security;

-- public reference and result tables: using (true)
grant select on exchanges, fx_rates, companies, securities, universe_snapshots, universe_membership_events, todays_discounts to anon, authenticated;
create policy exchanges_select                   on exchanges                   for select to anon, authenticated using (true);
create policy fx_rates_select                    on fx_rates                    for select to anon, authenticated using (true);
create policy companies_select                   on companies                   for select to anon, authenticated using (true);
create policy securities_select                  on securities                  for select to anon, authenticated using (true);
create policy universe_snapshots_select          on universe_snapshots          for select to anon, authenticated using (true);
create policy universe_membership_events_select  on universe_membership_events for select to anon, authenticated using (true);
create policy todays_discounts_select            on todays_discounts            for select to anon, authenticated using (true);

-- price_series: non-array columns only; the arrays are served by get_price_series() (A-41)
grant select (security_id, last_session_date, last_close, prev_close, bar_count, first_bar_date, last_bar_date, freshness, completeness)
  on price_series to anon, authenticated;
create policy price_series_select on price_series for select to anon, authenticated using (true);

-- scan_runs: settings_snapshot, errors_summary, code_version, trigger and heartbeat stay hidden
grant select (id, scan_date_local, status, started_at, finished_at, latest_session_date, coverage, session_dates,
              results_published_at, list_published_at, universe_sizes)
  on scan_runs to anon, authenticated;
create policy scan_runs_select on scan_runs for select to anon, authenticated using (true);

-- scan_security_results: universe scope, public columns (bars_hash is internal)
grant select (id, scan_run_id, security_id, scope, status, reason_codes, session_date, close, freshness, valid_bars, channel, market_cap_usd, tier1_member, computed_at)
  on scan_security_results to anon, authenticated;
create policy scan_security_results_select on scan_security_results for select to anon, authenticated using (scope = 'universe');

-- signal_episodes: discount kind is public; premium episodes arrive with P5 (holders only)
grant select on signal_episodes to anon, authenticated;
create policy signal_episodes_discount_select on signal_episodes for select to anon, authenticated using (kind = 'discount');

-- app_settings: only rows flagged is_public
grant select on app_settings to anon, authenticated;
create policy app_settings_public_select on app_settings for select to anon, authenticated using (is_public);

-- profiles: own row, safe columns (is_admin is not selectable or writable by the user)
grant select (user_id, display_name, timezone, default_destination, created_at) on profiles to authenticated;
grant update (display_name, timezone, default_destination) on profiles to authenticated;
create policy profiles_select_own on profiles for select to authenticated using (user_id = auth.uid());
create policy profiles_update_own on profiles for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- operational tables: admin read only (optional admin page); everything else is service role
grant select on scan_jobs, scan_events, audit_events to authenticated;
create policy scan_jobs_admin_select    on scan_jobs    for select to authenticated using (public.is_admin());
create policy scan_events_admin_select  on scan_events  for select to authenticated using (public.is_admin());
create policy audit_events_admin_select on audit_events for select to authenticated using (public.is_admin());
-- no grants and no policies: market_cap_snapshots, quote_cache, security_identity_overrides

-- views and public functions
revoke all on public.v_todays_discounts from anon, authenticated;
grant select on public.v_todays_discounts to anon, authenticated;
revoke execute on function public.company_list(universe_mode, int, int), public.universe_summary(universe_mode), public.scan_status(),
                           public.get_price_series(uuid), public.todays_discounts_feed(universe_mode) from public;
grant execute on function public.company_list(universe_mode, int, int), public.universe_summary(universe_mode), public.scan_status(),
                          public.get_price_series(uuid), public.todays_discounts_feed(universe_mode) to anon, authenticated;

-- ------------------------------------------------------------------ lock down schema app: service_role only
revoke execute on all functions in schema app from public, anon, authenticated;
grant execute on all functions in schema app to service_role;
