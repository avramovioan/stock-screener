-- P5b: broker tables, privileges, RLS, ingest / claim / cooldown / limiter functions, daily and minute cron entries.
-- Requires P1 (securities, quote_cache, signal_episodes), P2 (app.holder, risk_monitor_state).
-- Spec 6.3.6, 6.7, 6.8, 6.9, 7.1, 12.4, 12.8.

-- ------------------------------------------------------------------ enums (spec 6.2; guarded in case another migration created them)
do $$
begin
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public' and t.typname = 'broker_status') then
    create type public.broker_status as enum ('unlinked', 'linking', 'linked', 'error', 'expired');
  end if;
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public' and t.typname = 'sync_state') then
    create type public.sync_state as enum ('queued', 'requested', 'polling', 'parsing', 'done', 'failed', 'expired');
  end if;
end $$;

-- ------------------------------------------------------------------ tables (spec 6.3.6 plus the additive columns of P5b-D2)
create table if not exists public.broker_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users on delete cascade,        -- one connection per user in v1
  status public.broker_status not null default 'unlinked',
  flex_token_ciphertext bytea, flex_token_iv bytea, key_version int,           -- secret columns: no client SELECT (6.8)
  token_expires_on date,
  query_id text, account_id_masked text, base_currency char(3), account_type text,
  linked_at timestamptz, last_verified_at timestamptz, last_sync_at timestamptz, last_statement_date date,
  last_error_code int, last_error_message text, last_error_at timestamptz,
  last_manual_refresh_at timestamptz, next_flex_fetch_not_before timestamptz, last_flex_call_at timestamptz,
  coverage_from date,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.broker_sync_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  connection_id uuid not null references public.broker_connections on delete cascade,
  kind text not null check (kind in ('verify', 'daily', 'manual', 'backfill')),
  state public.sync_state not null default 'queued',
  reference_code text, requested_at timestamptz, last_poll_at timestamptz, poll_count int not null default 0, next_poll_at timestamptz,
  statement_from date, statement_to date, error_code int, error_message text,
  rows_summary jsonb not null default '{}', lease_until timestamptz,
  idempotency_key text not null unique,
  created_at timestamptz not null default now(), finished_at timestamptz
);
create unique index if not exists broker_sync_runs_one_active on public.broker_sync_runs (user_id)
  where state in ('queued', 'requested', 'polling', 'parsing');
create index if not exists broker_sync_runs_runnable on public.broker_sync_runs (next_poll_at)
  where state in ('queued', 'requested', 'polling', 'parsing');
create index if not exists broker_sync_runs_user_created on public.broker_sync_runs (user_id, created_at desc);

create table if not exists public.broker_positions (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade, report_date date not null,
  conid bigint not null, isin text, symbol text not null, description text, asset_class text, sub_category text, listing_exchange text,
  currency text not null, fx_rate_to_base numeric, quantity numeric not null, multiplier numeric not null default 1,
  mark_price numeric, position_value numeric, open_price numeric, cost_basis_price numeric, cost_basis_money numeric,
  fifo_pnl_unrealized numeric, percent_of_nav numeric, level_of_detail text not null default 'SUMMARY',
  open_date_time timestamptz,
  security_id uuid references public.securities,                                 -- the matched held line (valuation symbol)
  signal_security_id uuid references public.securities,                          -- the company's canonical listing (tags, premium, risk)
  match_status text not null default 'unmatched'
    check (match_status in ('matched_isin', 'matched_symbol_exchange', 'unmatched', 'not_equity')),
  valuation_tag text check (valuation_tag in ('discounted', 'premium', 'extra_premium', 'unavailable', 'none')),
  valuation_session_date date, valuation_reason text,
  constraint broker_positions_snapshot_key unique nulls not distinct (user_id, report_date, conid, level_of_detail, open_date_time)
);
create index if not exists broker_positions_user_report on public.broker_positions (user_id, report_date desc);
create index if not exists broker_positions_user_security on public.broker_positions (user_id, security_id);
create index if not exists broker_positions_signal_security on public.broker_positions (signal_security_id);

create table if not exists public.broker_trades (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade,
  trade_id text, ib_exec_id text not null, ib_order_id text, conid bigint not null, isin text, symbol text not null, description text,
  listing_exchange text, exchange text, currency text not null, fx_rate_to_base numeric,
  trade_date date not null, trade_time time, settle_date date,
  buy_sell text not null check (buy_sell in ('BUY', 'SELL')), quantity numeric not null, trade_price numeric not null,
  trade_money numeric, proceeds numeric, taxes numeric, ib_commission numeric, ib_commission_currency text, net_cash numeric,
  cost_basis numeric, fifo_pnl_realized numeric, open_close text, order_type text, report_date date,
  unique (user_id, ib_exec_id)
);
create index if not exists broker_trades_user_date on public.broker_trades (user_id, trade_date desc);

create table if not exists public.broker_closed_lots (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade,
  conid bigint not null, symbol text not null, currency text not null, fx_rate_to_base numeric,
  open_date_time timestamptz, close_date date not null, closing_trade_id text, quantity numeric not null,
  cost_basis numeric not null, proceeds numeric, fifo_pnl_realized numeric not null,
  dedupe_hash text not null, unique (user_id, dedupe_hash)
);
create index if not exists broker_closed_lots_user_close on public.broker_closed_lots (user_id, close_date desc);

create table if not exists public.broker_cash_transactions (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade,
  occurred_at timestamptz not null, report_date date, currency text not null, fx_rate_to_base numeric, amount numeric not null,
  type_raw text not null,
  category text not null check (category in ('dividend', 'withholding_tax', 'interest', 'fee', 'deposit_withdrawal', 'other')),
  conid bigint, isin text, symbol text, description text, trade_id text, code text,
  dedupe_hash text not null, unique (user_id, dedupe_hash)
);
create index if not exists broker_cash_user_occurred on public.broker_cash_transactions (user_id, occurred_at desc);

create table if not exists public.broker_corporate_actions (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade,
  kind text not null check (kind in ('corporate_action', 'transfer')), occurred_at timestamptz, conid bigint, symbol text, type_raw text,
  quantity numeric, amount numeric, currency text, code text, dedupe_hash text not null, unique (user_id, dedupe_hash)
);

create table if not exists public.broker_fx_rates (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade,
  rate_date date not null, from_ccy char(3) not null, to_ccy char(3) not null, rate numeric not null,
  unique (user_id, rate_date, from_ccy, to_ccy)
);

create table if not exists public.broker_nav (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade, report_date date not null, currency char(3) not null,
  cash numeric, stock numeric, other numeric, total numeric not null, unique (user_id, report_date)
);

drop trigger if exists broker_connections_touch on public.broker_connections;
create trigger broker_connections_touch before update on public.broker_connections
  for each row execute function app.touch_updated_at();

-- ------------------------------------------------------------------ privileges and RLS (spec 6.8, 6.9): owner SELECT only, no client writes
alter table public.broker_connections          enable row level security;
alter table public.broker_sync_runs            enable row level security;
alter table public.broker_positions            enable row level security;
alter table public.broker_trades               enable row level security;
alter table public.broker_closed_lots          enable row level security;
alter table public.broker_cash_transactions    enable row level security;
alter table public.broker_corporate_actions    enable row level security;
alter table public.broker_fx_rates             enable row level security;
alter table public.broker_nav                  enable row level security;

revoke all on public.broker_connections, public.broker_sync_runs, public.broker_positions, public.broker_trades,
              public.broker_closed_lots, public.broker_cash_transactions, public.broker_corporate_actions,
              public.broker_fx_rates, public.broker_nav from anon, authenticated;
-- belt and braces: even if a default privilege grants table-level SELECT later, the secret columns stay revoked
revoke select (flex_token_ciphertext, flex_token_iv, key_version) on public.broker_connections from anon, authenticated;

grant select (id, user_id, status, token_expires_on, query_id, account_id_masked, base_currency, account_type, linked_at, last_verified_at,
              last_sync_at, last_statement_date, last_error_code, last_error_message, last_error_at, next_flex_fetch_not_before,
              coverage_from, last_manual_refresh_at, updated_at)
  on public.broker_connections to authenticated;
grant select (id, user_id, connection_id, kind, state, statement_from, statement_to, poll_count, error_code, error_message, rows_summary, created_at, finished_at)
  on public.broker_sync_runs to authenticated;                                   -- no reference_code, lease_until or idempotency_key
grant select on public.broker_positions, public.broker_trades, public.broker_closed_lots, public.broker_cash_transactions,
                public.broker_corporate_actions, public.broker_fx_rates, public.broker_nav to authenticated;

do $$
declare t text;
begin
  foreach t in array array['broker_connections', 'broker_sync_runs', 'broker_positions', 'broker_trades', 'broker_closed_lots',
                           'broker_cash_transactions', 'broker_corporate_actions', 'broker_fx_rates', 'broker_nav'] loop
    execute format('drop policy if exists %I on public.%I', t || '_select_own', t);
    execute format('create policy %I on public.%I for select to authenticated using (user_id = (select auth.uid()))', t || '_select_own', t);
  end loop;
end $$;

-- ------------------------------------------------------------------ holder helpers (P2 hands app.holder to P5; the public twin backs RLS because authenticated has no USAGE on app)
create or replace function app.holder(p_security_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.broker_positions p
     where p.user_id = auth.uid() and (p.security_id = p_security_id or p.signal_security_id = p_security_id))
$$;

create or replace function public.holds_security(p_security_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.broker_positions p
     where p.user_id = auth.uid() and (p.security_id = p_security_id or p.signal_security_id = p_security_id))
$$;
revoke execute on function public.holds_security(uuid) from public, anon;
grant execute on function public.holds_security(uuid) to authenticated, service_role;

-- premium episodes exist only for held securities; hiding them from everybody else prevents leaking holdings (spec 6.9)
drop policy if exists signal_episodes_premium_holder on public.signal_episodes;
create policy signal_episodes_premium_holder on public.signal_episodes
  for select to authenticated
  using (kind in ('premium1', 'premium2') and public.holds_security(security_id));

-- Holdings that P2's risk monitor may watch: the latest snapshot of the user, matched, non-zero. SECURITY INVOKER: a client only ever sees its own rows,
-- the service role (which bypasses RLS) can ask for any user.
create or replace function public.monitored_holdings_for(p_user uuid)
returns table (security_id uuid, signal_security_id uuid, symbol text, isin text, conid bigint, report_date date, quantity numeric)
language sql stable security invoker set search_path = public as $$
  select p.security_id, coalesce(p.signal_security_id, p.security_id), p.symbol, p.isin, p.conid, p.report_date, p.quantity
    from public.broker_positions p
   where p.user_id = p_user
     and p.report_date = (select max(m.report_date) from public.broker_positions m where m.user_id = p_user)
     and p.quantity <> 0 and p.security_id is not null
     and p.match_status in ('matched_isin', 'matched_symbol_exchange')
$$;
revoke execute on function public.monitored_holdings_for(uuid) from public, anon;
grant execute on function public.monitored_holdings_for(uuid) to authenticated, service_role;

-- ------------------------------------------------------------------ ingest: one transaction per statement (spec 12.5)
create or replace function app.broker_ingest_statement(p_run_id uuid, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user uuid; v_conn uuid; v_report date; v_from date; v_to date; v_prev_stmt date; v_prev jsonb;
  n_pos int := 0; n_trd int := 0; n_lot int := 0; n_cash int := 0; n_fx int := 0; n_nav int := 0; n_corp int := 0;
begin
  select user_id, connection_id into v_user, v_conn from public.broker_sync_runs where id = p_run_id for update;
  if v_user is null then
    raise exception 'unknown sync run %', p_run_id using errcode = '22023';
  end if;
  v_report := (p_payload #>> '{meta,report_date}')::date;
  v_from := (p_payload #>> '{meta,statement_from}')::date;
  v_to := (p_payload #>> '{meta,statement_to}')::date;
  select last_statement_date into v_prev_stmt from public.broker_connections where id = v_conn;

  -- positions: the snapshot of the report date is replaced; matching and valuation state of the same conid is carried over
  select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) into v_prev from (
    select distinct on (conid) conid, security_id, signal_security_id, match_status, valuation_tag, valuation_session_date, valuation_reason
      from public.broker_positions where user_id = v_user order by conid, report_date desc) q;
  delete from public.broker_positions where user_id = v_user and report_date = v_report;
  insert into public.broker_positions
    (user_id, report_date, conid, isin, symbol, description, asset_class, sub_category, listing_exchange, currency, fx_rate_to_base, quantity, multiplier,
     mark_price, position_value, open_price, cost_basis_price, cost_basis_money, fifo_pnl_unrealized, percent_of_nav, level_of_detail, open_date_time,
     security_id, signal_security_id, match_status, valuation_tag, valuation_session_date, valuation_reason)
  select v_user, v_report, x.conid, x.isin, x.symbol, x.description, x.asset_class, x.sub_category, x.listing_exchange, x.currency, x.fx_rate_to_base,
         x.quantity, coalesce(x.multiplier, 1), x.mark_price, x.position_value, x.open_price, x.cost_basis_price, x.cost_basis_money,
         x.fifo_pnl_unrealized, x.percent_of_nav, coalesce(x.level_of_detail, 'SUMMARY'), x.open_date_time,
         pm.security_id, pm.signal_security_id, coalesce(pm.match_status, 'unmatched'), pm.valuation_tag, pm.valuation_session_date, pm.valuation_reason
    from jsonb_to_recordset(p_payload -> 'positions') as x(
           conid bigint, isin text, symbol text, description text, asset_class text, sub_category text, listing_exchange text, currency text,
           fx_rate_to_base numeric, quantity numeric, multiplier numeric, mark_price numeric, position_value numeric, open_price numeric,
           cost_basis_price numeric, cost_basis_money numeric, fifo_pnl_unrealized numeric, percent_of_nav numeric, level_of_detail text,
           open_date_time timestamptz)
    left join jsonb_to_recordset(v_prev) as pm(
           conid bigint, security_id uuid, signal_security_id uuid, match_status text, valuation_tag text, valuation_session_date date, valuation_reason text)
      on pm.conid = x.conid
  on conflict do nothing;
  get diagnostics n_pos = row_count;

  -- executions: later statements may refine the P/L fields (Flex errors 1006-1008: P/L can lag), identity fields never change
  insert into public.broker_trades as t
    (user_id, trade_id, ib_exec_id, ib_order_id, conid, isin, symbol, description, listing_exchange, exchange, currency, fx_rate_to_base, trade_date, trade_time,
     settle_date, buy_sell, quantity, trade_price, trade_money, proceeds, taxes, ib_commission, ib_commission_currency, net_cash, cost_basis, fifo_pnl_realized,
     open_close, order_type, report_date)
  select v_user, x.trade_id, x.ib_exec_id, x.ib_order_id, x.conid, x.isin, x.symbol, x.description, x.listing_exchange, x.exchange, x.currency,
         x.fx_rate_to_base, x.trade_date, x.trade_time, x.settle_date, x.buy_sell, x.quantity, x.trade_price, x.trade_money, x.proceeds, x.taxes,
         x.ib_commission, x.ib_commission_currency, x.net_cash, x.cost_basis, x.fifo_pnl_realized, x.open_close, x.order_type, x.report_date
    from jsonb_to_recordset(p_payload -> 'trades') as x(
           trade_id text, ib_exec_id text, ib_order_id text, conid bigint, isin text, symbol text, description text, listing_exchange text, exchange text,
           currency text, fx_rate_to_base numeric, trade_date date, trade_time time, settle_date date, buy_sell text, quantity numeric, trade_price numeric,
           trade_money numeric, proceeds numeric, taxes numeric, ib_commission numeric, ib_commission_currency text, net_cash numeric, cost_basis numeric,
           fifo_pnl_realized numeric, open_close text, order_type text, report_date date)
  on conflict (user_id, ib_exec_id) do update set
    fx_rate_to_base = excluded.fx_rate_to_base, ib_commission = excluded.ib_commission, net_cash = excluded.net_cash, cost_basis = excluded.cost_basis,
    fifo_pnl_realized = excluded.fifo_pnl_realized, report_date = excluded.report_date,
    listing_exchange = coalesce(excluded.listing_exchange, t.listing_exchange);
  get diagnostics n_trd = row_count;

  insert into public.broker_closed_lots
    (user_id, conid, symbol, currency, fx_rate_to_base, open_date_time, close_date, closing_trade_id, quantity, cost_basis, proceeds, fifo_pnl_realized, dedupe_hash)
  select v_user, x.conid, x.symbol, x.currency, x.fx_rate_to_base, x.open_date_time, x.close_date, x.closing_trade_id, x.quantity, x.cost_basis, x.proceeds,
         x.fifo_pnl_realized, x.dedupe_hash
    from jsonb_to_recordset(p_payload -> 'closed_lots') as x(
           conid bigint, symbol text, currency text, fx_rate_to_base numeric, open_date_time timestamptz, close_date date, closing_trade_id text,
           quantity numeric, cost_basis numeric, proceeds numeric, fifo_pnl_realized numeric, dedupe_hash text)
  on conflict (user_id, dedupe_hash) do update set
    fx_rate_to_base = excluded.fx_rate_to_base, proceeds = excluded.proceeds, fifo_pnl_realized = excluded.fifo_pnl_realized;
  get diagnostics n_lot = row_count;

  insert into public.broker_cash_transactions
    (user_id, occurred_at, report_date, currency, fx_rate_to_base, amount, type_raw, category, conid, isin, symbol, description, trade_id, code, dedupe_hash)
  select v_user, x.occurred_at, x.report_date, x.currency, x.fx_rate_to_base, x.amount, x.type_raw, x.category, x.conid, x.isin, x.symbol, x.description,
         x.trade_id, x.code, x.dedupe_hash
    from jsonb_to_recordset(p_payload -> 'cash') as x(
           occurred_at timestamptz, report_date date, currency text, fx_rate_to_base numeric, amount numeric, type_raw text, category text, conid bigint,
           isin text, symbol text, description text, trade_id text, code text, dedupe_hash text)
  on conflict (user_id, dedupe_hash) do nothing;
  get diagnostics n_cash = row_count;

  insert into public.broker_fx_rates (user_id, rate_date, from_ccy, to_ccy, rate)
  select v_user, x.rate_date, x.from_ccy, x.to_ccy, x.rate
    from jsonb_to_recordset(p_payload -> 'fx') as x(rate_date date, from_ccy text, to_ccy text, rate numeric)
  on conflict (user_id, rate_date, from_ccy, to_ccy) do update set rate = excluded.rate;
  get diagnostics n_fx = row_count;

  insert into public.broker_nav (user_id, report_date, currency, cash, stock, other, total)
  select v_user, x.report_date, x.currency, x.cash, x.stock, x.other, x.total
    from jsonb_to_recordset(p_payload -> 'nav') as x(report_date date, currency text, cash numeric, stock numeric, other numeric, total numeric)
  on conflict (user_id, report_date) do update set currency = excluded.currency, cash = excluded.cash, stock = excluded.stock, other = excluded.other, total = excluded.total;
  get diagnostics n_nav = row_count;

  insert into public.broker_corporate_actions (user_id, kind, occurred_at, conid, symbol, type_raw, quantity, amount, currency, code, dedupe_hash)
  select v_user, x.kind, x.occurred_at, x.conid, x.symbol, x.type_raw, x.quantity, x.amount, x.currency, x.code, x.dedupe_hash
    from jsonb_to_recordset(p_payload -> 'corporate_actions') as x(
           kind text, occurred_at timestamptz, conid bigint, symbol text, type_raw text, quantity numeric, amount numeric, currency text, code text, dedupe_hash text)
  on conflict (user_id, dedupe_hash) do nothing;
  get diagnostics n_corp = row_count;

  update public.broker_connections set
    last_sync_at = now(),
    last_statement_date = greatest(coalesce(last_statement_date, v_to), v_to),
    coverage_from = least(coalesce(coverage_from, v_from), v_from),
    base_currency = coalesce(nullif(p_payload #>> '{meta,base_currency}', ''), base_currency),
    account_id_masked = coalesce(nullif(p_payload #>> '{meta,account_id_masked}', ''), account_id_masked),
    account_type = coalesce(nullif(p_payload #>> '{meta,account_type}', ''), account_type),
    next_flex_fetch_not_before = case when v_prev_stmt is not null and v_to <= v_prev_stmt then now() + interval '6 hours' else null end,
    last_error_code = null, last_error_message = null, last_error_at = null
   where id = v_conn;

  update public.broker_sync_runs set
    rows_summary = coalesce(rows_summary, '{}'::jsonb) || jsonb_build_object(
      'positions', n_pos, 'trades', n_trd, 'closed_lots', n_lot, 'cash', n_cash, 'fx', n_fx, 'nav', n_nav, 'corporate_actions', n_corp)
   where id = p_run_id;

  return jsonb_build_object('report_date', v_report, 'positions', n_pos, 'trades', n_trd, 'closed_lots', n_lot, 'cash', n_cash,
                            'fx', n_fx, 'nav', n_nav, 'corporate_actions', n_corp);
end $$;

-- ------------------------------------------------------------------ claim runs for the minute tick (leases, SKIP LOCKED)
create or replace function app.claim_broker_runs(p_limit int default 3, p_lease_seconds int default 150)
returns setof public.broker_sync_runs
language sql security definer set search_path = public, pg_temp as $$
  with c as (
    select r.id from public.broker_sync_runs r
     where r.state in ('queued', 'requested', 'polling', 'parsing')
       and coalesce(r.next_poll_at, now()) <= now()
       and (r.lease_until is null or r.lease_until < now())
     order by coalesce(r.next_poll_at, r.created_at)
     limit greatest(p_limit, 1)
     for update skip locked)
  update public.broker_sync_runs r set lease_until = now() + make_interval(secs => p_lease_seconds)
    from c where r.id = c.id
  returning r.*
$$;

-- atomic lease for an inline (user-triggered) advance
create or replace function app.lease_broker_run(p_run uuid, p_lease_seconds int default 150)
returns setof public.broker_sync_runs
language sql security definer set search_path = public, pg_temp as $$
  update public.broker_sync_runs r set lease_until = now() + make_interval(secs => p_lease_seconds)
   where r.id = p_run and r.state in ('queued', 'requested', 'polling', 'parsing') and (r.lease_until is null or r.lease_until < now())
  returning r.*
$$;

-- ------------------------------------------------------------------ manual refresh cooldown (60 s): ONE atomic UPDATE ... WHERE (spec 12.8)
create or replace function app.claim_manual_refresh(p_user uuid) returns table (claimed boolean, available_at timestamptz)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_at timestamptz;
begin
  update public.broker_connections set last_manual_refresh_at = now()
   where user_id = p_user and status not in ('unlinked', 'linking')
     and (last_manual_refresh_at is null or last_manual_refresh_at <= now() - interval '60 seconds')
  returning last_manual_refresh_at into v_at;
  if found then
    return query select true, v_at + interval '60 seconds';
    return;
  end if;
  select c.last_manual_refresh_at + interval '60 seconds' into v_at from public.broker_connections c where c.user_id = p_user;
  return query select false, v_at;
end $$;

-- ------------------------------------------------------------------ manual Flex sync: one per 10 minutes, one active run
create or replace function app.enqueue_manual_sync(p_user uuid) returns table (run_id uuid, outcome text, retry_after_seconds int)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_conn public.broker_connections; v_run uuid; v_last timestamptz; v_wait int;
begin
  perform pg_advisory_xact_lock(hashtextextended('broker_manual_sync:' || p_user::text, 0));
  select * into v_conn from public.broker_connections where user_id = p_user;
  if not found or v_conn.status <> 'linked' then
    return query select null::uuid, 'not_linked'::text, 0;
    return;
  end if;
  select r.id into v_run from public.broker_sync_runs r
   where r.user_id = p_user and r.state in ('queued', 'requested', 'polling', 'parsing') limit 1;
  if v_run is not null then
    return query select v_run, 'busy'::text, 0;
    return;
  end if;
  select max(r.created_at) into v_last from public.broker_sync_runs r where r.user_id = p_user and r.kind = 'manual';
  if v_last is not null and v_last > now() - interval '10 minutes' then
    v_wait := greatest(1, ceil(extract(epoch from (v_last + interval '10 minutes' - now())))::int);
    return query select null::uuid, 'cooldown'::text, v_wait;
    return;
  end if;
  insert into public.broker_sync_runs (user_id, connection_id, kind, state, statement_from, statement_to, idempotency_key)
  values (p_user, v_conn.id, 'manual', 'queued',
          case when v_conn.last_statement_date is null then null else v_conn.last_statement_date - 5 end,
          (now() at time zone 'Europe/Sofia')::date - 1,
          p_user::text || ':manual:' || gen_random_uuid()::text)
  returning id into v_run;
  return query select v_run, 'created'::text, 0;
end $$;

-- ------------------------------------------------------------------ Flex limiter: 1.1 s spacing and 10 calls per rolling 60 s per token hash
create or replace function app.flex_rl_take(p_key text) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_now bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_row jsonb; v_recent bigint[]; v_wait int := 0;
begin
  if p_key is null or p_key !~ '^flexrl:[0-9a-zA-Z_-]{1,64}$' then
    raise exception 'invalid limiter key' using errcode = '22023';
  end if;
  insert into public.quote_cache (key, payload, provider, expires_at)
  values (p_key, '{"calls":[]}'::jsonb, 'flex', now() + interval '1 hour')
  on conflict (key) do nothing;
  select payload into v_row from public.quote_cache where key = p_key for update;
  select coalesce(array_agg(t.ms order by t.ms), '{}'::bigint[]) into v_recent
    from (select x::bigint as ms from jsonb_array_elements_text(coalesce(v_row -> 'calls', '[]'::jsonb)) x) t
   where t.ms > v_now - 60000;
  if cardinality(v_recent) > 0 and v_now - v_recent[cardinality(v_recent)] < 1100 then
    v_wait := (v_recent[cardinality(v_recent)] + 1100 - v_now)::int;
  elsif cardinality(v_recent) >= 10 then
    v_wait := (v_recent[1] + 60000 - v_now)::int + 50;
  end if;
  if v_wait > 0 then
    update public.quote_cache set payload = jsonb_build_object('calls', to_jsonb(v_recent)), expires_at = now() + interval '1 hour' where key = p_key;
    return v_wait;
  end if;
  v_recent := v_recent || v_now;
  update public.quote_cache set payload = jsonb_build_object('calls', to_jsonb(v_recent)), expires_at = now() + interval '1 hour' where key = p_key;
  return 0;
end $$;

-- ------------------------------------------------------------------ holding tags (portfolio_scan writes them for every holder of the security)
create or replace function app.apply_holding_tag(p_security uuid, p_tag text, p_session date, p_reason text) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  if p_tag not in ('discounted', 'premium', 'extra_premium', 'unavailable', 'none') then
    raise exception 'invalid valuation tag %', p_tag using errcode = '22023';
  end if;
  update public.broker_positions p
     set valuation_tag = p_tag, valuation_session_date = p_session, valuation_reason = p_reason
   where p.signal_security_id = p_security
     and p.report_date = (select max(m.report_date) from public.broker_positions m where m.user_id = p.user_id);
  get diagnostics n = row_count;
  return n;
end $$;

-- distinct signal securities of the latest snapshot of every user (portfolio_scan seeds its jobs from this)
create or replace function app.held_signal_securities() returns table (security_id uuid)
language sql stable security definer set search_path = public, pg_temp as $$
  select distinct p.signal_security_id
    from public.broker_positions p
   where p.signal_security_id is not null and p.quantity <> 0
     and p.report_date = (select max(m.report_date) from public.broker_positions m where m.user_id = p.user_id)
$$;

-- ------------------------------------------------------------------ daily seeding (08:00 Europe/Sofia, A-33) and the broker tick
create or replace function app.kick_broker_sync() returns void
language plpgsql security definer set search_path = public, app, vault, net as $$
declare v_url text; v_secret text; v_hdr jsonb;
begin
  if not exists (select 1 from public.broker_sync_runs r
                  where r.state in ('queued', 'requested', 'polling', 'parsing') and coalesce(r.next_poll_at, now()) <= now()
                    and (r.lease_until is null or r.lease_until < now())) then
    return;
  end if;
  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'worker_tick_secret';
  if v_url is null or v_secret is null then return; end if;
  v_hdr := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret);
  perform net.http_post(url := v_url || '/functions/v1/broker-sync', headers := v_hdr, body := '{"action":"tick"}'::jsonb, timeout_milliseconds := 145000);
end $$;

create or replace function app.start_daily_broker_syncs(p_now timestamptz default now(), p_force boolean default false) returns int
language plpgsql security definer set search_path = public, app as $$
declare v_date date := (p_now at time zone 'Europe/Sofia')::date; v_n int;
begin
  -- DST-safe guard (same idea as 7.2): of the 05:00 and 06:00 UTC firings exactly one is 08:00 in Sofia
  if not p_force and extract(hour from (p_now at time zone 'Europe/Sofia')) <> 8 then
    return 0;
  end if;
  with ins as (
    insert into public.broker_sync_runs (user_id, connection_id, kind, state, statement_from, statement_to, idempotency_key)
    select c.user_id, c.id, 'daily', 'queued',
           case when c.last_statement_date is null then null else c.last_statement_date - 5 end,
           v_date - 1,
           c.user_id::text || ':daily:' || v_date::text
      from public.broker_connections c
     where c.status = 'linked' and (c.next_flex_fetch_not_before is null or c.next_flex_fetch_not_before <= p_now)
    on conflict do nothing
    returning 1)
  select count(*)::int into v_n from ins;
  if v_n > 0 then perform app.kick_broker_sync(); end if;
  return v_n;
end $$;

-- ------------------------------------------------------------------ grants on app functions: service role only
revoke all on function app.broker_ingest_statement(uuid, jsonb), app.claim_broker_runs(int, int), app.lease_broker_run(uuid, int),
  app.claim_manual_refresh(uuid), app.enqueue_manual_sync(uuid), app.flex_rl_take(text), app.apply_holding_tag(uuid, text, date, text),
  app.kick_broker_sync(), app.start_daily_broker_syncs(timestamptz, boolean), app.held_signal_securities() from public, anon, authenticated;
grant execute on function app.broker_ingest_statement(uuid, jsonb), app.claim_broker_runs(int, int), app.lease_broker_run(uuid, int),
  app.claim_manual_refresh(uuid), app.enqueue_manual_sync(uuid), app.flex_rl_take(text), app.apply_holding_tag(uuid, text, date, text),
  app.kick_broker_sync(), app.start_daily_broker_syncs(timestamptz, boolean), app.held_signal_securities() to service_role;

-- ------------------------------------------------------------------ cron entries (idempotent: unschedule by name first)
do $$
declare j bigint;
begin
  for j in select jobid from cron.job where jobname in ('broker-daily-0500', 'broker-daily-0600', 'broker-tick') loop
    perform cron.unschedule(j);
  end loop;
end $$;
select cron.schedule('broker-daily-0500', '0 5 * * *', 'select app.start_daily_broker_syncs();');
select cron.schedule('broker-daily-0600', '0 6 * * *', 'select app.start_daily_broker_syncs();');
select cron.schedule('broker-tick', '* * * * *', 'select app.kick_broker_sync();');
