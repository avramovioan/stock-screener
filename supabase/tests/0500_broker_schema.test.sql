begin;
create extension if not exists pgtap with schema extensions;
select plan(91);

-- isolation: a seeded database (e2e setup) already holds broker rows; the counts below assume none (rolled back with the transaction)
truncate public.broker_connections, public.broker_positions, public.broker_sync_runs cascade;


create function pg_temp.set_claims(p_uid text) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', p_uid, true);
end $$;

-- three users: A and B are linked, C is not
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values
  ('a0000000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a@example.test', now(), now()),
  ('b0000000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b@example.test', now(), now()),
  ('c0000000-0000-4000-8000-00000000000c', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'c@example.test', now(), now());

insert into public.broker_connections
  (id, user_id, status, flex_token_ciphertext, flex_token_iv, key_version, query_id, base_currency, last_statement_date) values
  ('c1000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-00000000000a', 'linked', '\x0102'::bytea, '\x0a0b'::bytea, 1, '111', 'EUR', '2026-10-09'),
  ('c2000000-0000-4000-8000-00000000000b', 'b0000000-0000-4000-8000-00000000000b', 'linked', '\x0304'::bytea, '\x0c0d'::bytea, 1, '222', 'USD', null),
  ('c3000000-0000-4000-8000-00000000000c', 'c0000000-0000-4000-8000-00000000000c', 'unlinked', null, null, null, null, null, null);

-- ---------------------------------------------------------------- schema, enums, RLS flags, privileges (as the table owner)
select is((select count(*)::int from pg_tables where schemaname = 'public' and tablename like 'broker\_%'), 9,
  'nine broker tables exist');
select enum_has_labels('public', 'broker_status', array['unlinked', 'linking', 'linked', 'error', 'expired'], 'broker_status labels');
select enum_has_labels('public', 'sync_state', array['queued', 'requested', 'polling', 'parsing', 'done', 'failed', 'expired'], 'sync_state labels');
select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'broker\_%' and c.relrowsecurity), 9,
  'row level security is enabled on every broker table');
select is(has_column_privilege('authenticated', 'public.broker_connections', 'flex_token_ciphertext', 'select'), false,
  'authenticated cannot select the token ciphertext');
select is(has_column_privilege('authenticated', 'public.broker_connections', 'flex_token_iv', 'select'), false,
  'authenticated cannot select the token IV');
select is(has_column_privilege('authenticated', 'public.broker_connections', 'key_version', 'select'), false,
  'authenticated cannot select the key version');
select is(has_column_privilege('authenticated', 'public.broker_connections', 'status', 'select'), true,
  'authenticated can select the status');
select is(has_column_privilege('anon', 'public.broker_connections', 'status', 'select'), false,
  'anon cannot select anything from broker_connections');
select ok(exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'broker_sync_runs_one_active'),
  'one active run per user is enforced by a partial unique index');
select ok(exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'signal_episodes' and policyname = 'signal_episodes_premium_holder'),
  'premium episodes have a holders-only policy');

-- ---------------------------------------------------------------- app.broker_ingest_statement: one transaction, idempotent, snapshot replace
create temp table _p as select $j$
{
  "meta": {"report_date": "2026-10-14", "statement_from": "2026-09-15", "statement_to": "2026-10-14",
           "account_id_masked": "U***4567", "base_currency": "EUR", "account_type": "Individual"},
  "positions": [
    {"conid": 100001, "isin": "US0378331005", "symbol": "AAPL", "description": "APPLE INC", "asset_class": "STK", "sub_category": "COMMON",
     "listing_exchange": "NASDAQ", "currency": "USD", "fx_rate_to_base": 0.92, "quantity": 10, "multiplier": 1, "mark_price": 230,
     "position_value": 2300, "open_price": 200.17, "cost_basis_price": 200.17, "cost_basis_money": 2001.7, "fifo_pnl_unrealized": 298.3,
     "percent_of_nav": 12.5, "level_of_detail": "SUMMARY", "open_date_time": null},
    {"conid": 100002, "isin": "GB00BP6MXD84", "symbol": "SHEL", "description": "SHELL PLC", "asset_class": "STK", "sub_category": "COMMON",
     "listing_exchange": "LSE", "currency": "GBP", "fx_rate_to_base": 1.15, "quantity": 100, "multiplier": 1, "mark_price": 27.35,
     "position_value": 2735, "open_price": 25, "cost_basis_price": 25, "cost_basis_money": 2500, "fifo_pnl_unrealized": 235,
     "percent_of_nav": 17.1, "level_of_detail": "SUMMARY", "open_date_time": null}
  ],
  "trades": [
    {"trade_id": "1001001", "ib_exec_id": "E-0001", "ib_order_id": "5001", "conid": 100001, "isin": null, "symbol": "AAPL", "description": "APPLE INC",
     "listing_exchange": "NASDAQ", "exchange": "NASDAQ", "currency": "USD", "fx_rate_to_base": 0.92, "trade_date": "2026-10-09", "trade_time": "09:30:01",
     "settle_date": null, "buy_sell": "BUY", "quantity": 6, "trade_price": 199.5, "trade_money": 1197, "proceeds": -1197, "taxes": 0,
     "ib_commission": -1, "ib_commission_currency": "USD", "net_cash": -1198, "cost_basis": 1198, "fifo_pnl_realized": 0, "open_close": "O",
     "order_type": "LMT", "report_date": "2026-10-14"},
    {"trade_id": "1001002", "ib_exec_id": "E-0002", "ib_order_id": "5001", "conid": 100001, "isin": null, "symbol": "AAPL", "description": "APPLE INC",
     "listing_exchange": "NASDAQ", "exchange": "NASDAQ", "currency": "USD", "fx_rate_to_base": 0.92, "trade_date": "2026-10-09", "trade_time": "09:30:07",
     "settle_date": null, "buy_sell": "BUY", "quantity": 4, "trade_price": 200.75, "trade_money": 803, "proceeds": -803, "taxes": 0,
     "ib_commission": -0.7, "ib_commission_currency": "USD", "net_cash": -803.7, "cost_basis": 803.7, "fifo_pnl_realized": 0, "open_close": "O",
     "order_type": "LMT", "report_date": "2026-10-14"}
  ],
  "closed_lots": [
    {"conid": 100002, "symbol": "SHEL", "currency": "GBP", "fx_rate_to_base": 1.15, "open_date_time": "2026-01-15T09:30:00Z", "close_date": "2026-10-08",
     "closing_trade_id": "2002001", "quantity": 3, "cost_basis": 75, "proceeds": 79.5, "fifo_pnl_realized": 4.2, "dedupe_hash": "lot-hash-a"},
    {"conid": 100002, "symbol": "SHEL", "currency": "GBP", "fx_rate_to_base": 1.15, "open_date_time": "2026-02-20T10:15:00Z", "close_date": "2026-10-08",
     "closing_trade_id": "2002001", "quantity": 1, "cost_basis": 26, "proceeds": 26.5, "fifo_pnl_realized": 0.4, "dedupe_hash": "lot-hash-b"}
  ],
  "cash": [
    {"occurred_at": "2026-10-10T00:00:00Z", "report_date": "2026-10-14", "currency": "USD", "fx_rate_to_base": 0.92, "amount": 2.6, "type_raw": "Dividends",
     "category": "dividend", "conid": 100001, "isin": "US0378331005", "symbol": "AAPL", "description": "AAPL cash dividend", "trade_id": null, "code": null,
     "dedupe_hash": "cash-hash-a"},
    {"occurred_at": "2026-10-10T00:00:00Z", "report_date": "2026-10-14", "currency": "USD", "fx_rate_to_base": 0.92, "amount": -0.39, "type_raw": "Withholding Tax",
     "category": "withholding_tax", "conid": 100001, "isin": "US0378331005", "symbol": "AAPL", "description": "AAPL withholding", "trade_id": null, "code": null,
     "dedupe_hash": "cash-hash-b"}
  ],
  "fx": [
    {"rate_date": "2026-10-14", "from_ccy": "USD", "to_ccy": "EUR", "rate": 0.92},
    {"rate_date": "2026-10-14", "from_ccy": "GBP", "to_ccy": "EUR", "rate": 1.15}
  ],
  "nav": [
    {"report_date": "2026-10-13", "currency": "EUR", "cash": 1000, "stock": 8800.55, "other": null, "total": 9800.55},
    {"report_date": "2026-10-14", "currency": "EUR", "cash": 1000, "stock": 8950.2, "other": null, "total": 9950.2}
  ],
  "corporate_actions": []
}
$j$::jsonb as payload;

insert into public.broker_sync_runs (id, user_id, connection_id, kind, state, idempotency_key) values
  ('f0000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-00000000000a', 'c1000000-0000-4000-8000-00000000000a', 'verify', 'parsing', 'test:ingest-a');

select lives_ok($$select app.broker_ingest_statement('f0000000-0000-4000-8000-00000000000a', (select payload from _p))$$, 'the first ingest succeeds');
select is((select count(*)::int from public.broker_positions where user_id = 'a0000000-0000-4000-8000-00000000000a'), 2, 'two positions');
select is((select count(*)::int from public.broker_trades where user_id = 'a0000000-0000-4000-8000-00000000000a'), 2, 'two executions of one order (partial fills)');
select is((select count(*)::int from public.broker_closed_lots where user_id = 'a0000000-0000-4000-8000-00000000000a'), 2, 'two closed lots of one partial sale');
select is((select count(*)::int from public.broker_cash_transactions where user_id = 'a0000000-0000-4000-8000-00000000000a'), 2, 'dividend and withholding rows');
select is((select count(*)::int from public.broker_fx_rates where user_id = 'a0000000-0000-4000-8000-00000000000a'), 2, 'two conversion rates');
select is((select count(*)::int from public.broker_nav where user_id = 'a0000000-0000-4000-8000-00000000000a'), 2, 'two NAV rows');
select is((select sum(fifo_pnl_realized) from public.broker_closed_lots where user_id = 'a0000000-0000-4000-8000-00000000000a'), 4.6::numeric,
  'the partial-sale lots add up to the execution P/L (4.60), nothing is counted twice');
select is((select last_statement_date from public.broker_connections where user_id = 'a0000000-0000-4000-8000-00000000000a'), '2026-10-14'::date,
  'last_statement_date advances to the statement end');
select is((select coverage_from from public.broker_connections where user_id = 'a0000000-0000-4000-8000-00000000000a'), '2026-09-15'::date,
  'coverage_from is the statement start');
select is((select next_flex_fetch_not_before from public.broker_connections where user_id = 'a0000000-0000-4000-8000-00000000000a'), null,
  'a statement with a new day does not delay the next fetch');

select lives_ok($$select app.broker_ingest_statement('f0000000-0000-4000-8000-00000000000a', (select payload from _p))$$, 'the same statement can be ingested again');
select is((select (select count(*) from public.broker_positions where user_id = 'a0000000-0000-4000-8000-00000000000a')
               + (select count(*) from public.broker_trades where user_id = 'a0000000-0000-4000-8000-00000000000a')
               + (select count(*) from public.broker_closed_lots where user_id = 'a0000000-0000-4000-8000-00000000000a')
               + (select count(*) from public.broker_cash_transactions where user_id = 'a0000000-0000-4000-8000-00000000000a')
               + (select count(*) from public.broker_fx_rates where user_id = 'a0000000-0000-4000-8000-00000000000a')
               + (select count(*) from public.broker_nav where user_id = 'a0000000-0000-4000-8000-00000000000a'))::int, 12,
  're-ingest creates no duplicate rows');
select ok((select next_flex_fetch_not_before from public.broker_connections where user_id = 'a0000000-0000-4000-8000-00000000000a') > now(),
  'a statement that brings no new day pushes the next Flex fetch 6 hours out');

update public.broker_positions set match_status = 'matched_isin', valuation_tag = 'discounted', valuation_session_date = '2026-10-13'
 where user_id = 'a0000000-0000-4000-8000-00000000000a' and conid = 100001;
select lives_ok($$select app.broker_ingest_statement('f0000000-0000-4000-8000-00000000000a', (select payload #- '{positions,1}' from _p))$$,
  'a statement with fewer positions replaces the snapshot of its report date');
select is((select count(*)::int from public.broker_positions where user_id = 'a0000000-0000-4000-8000-00000000000a'), 1, 'the snapshot was replaced, not merged');
select is((select valuation_tag from public.broker_positions where user_id = 'a0000000-0000-4000-8000-00000000000a' and conid = 100001), 'discounted',
  'matching state and valuation tag of the same conid are carried over');
select is((select count(*)::int from public.broker_positions where user_id = 'b0000000-0000-4000-8000-00000000000b'), 0, 'the other user has no rows');
select throws_ok($$select app.broker_ingest_statement('00000000-0000-4000-8000-000000000999', '{}'::jsonb)$$, '22023', null,
  'an unknown run is rejected');
update public.broker_sync_runs set state = 'done';

-- ---------------------------------------------------------------- app.flex_rl_take: 1.1 s spacing and 10 calls per rolling 60 s
select is(app.flex_rl_take('flexrl:test'), 0, 'the first Flex call is granted');
select cmp_ok(app.flex_rl_take('flexrl:test'), '>', 0, 'a second call within 1.1 s must wait');
select cmp_ok(app.flex_rl_take('flexrl:test'), '<=', 1100, 'the wait never exceeds the 1.1 s spacing');
update public.quote_cache
   set payload = jsonb_build_object('calls', (select jsonb_agg((extract(epoch from clock_timestamp()) * 1000)::bigint - 59000 + i * 1500 order by i)
                                                from generate_series(0, 9) i))
 where key = 'flexrl:test';
select cmp_ok(app.flex_rl_take('flexrl:test'), '>', 0, 'the 11th call inside 60 s must wait');
select cmp_ok(app.flex_rl_take('flexrl:test'), '<=', 61000, 'the 60 s window bounds the wait');
update public.quote_cache
   set payload = jsonb_build_object('calls', jsonb_build_array((extract(epoch from clock_timestamp()) * 1000)::bigint - 90000))
 where key = 'flexrl:test';
select is(app.flex_rl_take('flexrl:test'), 0, 'calls older than 60 s no longer count');
select is(has_function_privilege('authenticated', 'app.flex_rl_take(text)', 'execute'), false, 'authenticated cannot call the limiter');
select is(has_function_privilege('anon', 'app.flex_rl_take(text)', 'execute'), false, 'anon cannot call the limiter');

-- ---------------------------------------------------------------- app.claim_manual_refresh: one atomic UPDATE ... WHERE (60 s cooldown)
select is((select claimed from app.claim_manual_refresh('a0000000-0000-4000-8000-00000000000a')), true, 'the first manual refresh is claimed');
select is((select claimed from app.claim_manual_refresh('a0000000-0000-4000-8000-00000000000a')), false, 'a second claim inside 60 s is refused');
select ok((select available_at from app.claim_manual_refresh('a0000000-0000-4000-8000-00000000000a')) > now(), 'the refusal reports when the next claim is possible');
select is((select claimed from app.claim_manual_refresh('b0000000-0000-4000-8000-00000000000b')), true, 'another user is not affected');
update public.broker_connections set last_manual_refresh_at = now() - interval '61 seconds' where user_id = 'a0000000-0000-4000-8000-00000000000a';
select is((select claimed from app.claim_manual_refresh('a0000000-0000-4000-8000-00000000000a')), true, 'after 61 s the claim succeeds again');
select is((select claimed from app.claim_manual_refresh('c0000000-0000-4000-8000-00000000000c')), false, 'an unlinked connection cannot claim a refresh');

-- ---------------------------------------------------------------- app.enqueue_manual_sync: 10 minute cooldown, one active run
select is((select outcome from app.enqueue_manual_sync('a0000000-0000-4000-8000-00000000000a')), 'created', 'the first manual sync is queued');
select is((select outcome from app.enqueue_manual_sync('a0000000-0000-4000-8000-00000000000a')), 'busy', 'a sync is refused while a run is active');
update public.broker_sync_runs set state = 'done';
select is((select outcome from app.enqueue_manual_sync('a0000000-0000-4000-8000-00000000000a')), 'cooldown', 'a second manual sync inside 10 minutes is refused');
select ok((select retry_after_seconds from app.enqueue_manual_sync('a0000000-0000-4000-8000-00000000000a')) between 1 and 600, 'the cooldown reports the remaining seconds');
select is((select outcome from app.enqueue_manual_sync('c0000000-0000-4000-8000-00000000000c')), 'not_linked', 'an unlinked user cannot sync');
update public.broker_sync_runs set state = 'done';

-- ---------------------------------------------------------------- cron entries and app.start_daily_broker_syncs (Sofia hour guard = 8)
select is((select schedule from cron.job where jobname = 'broker-daily-0500'), '0 5 * * *', 'broker-daily-0500 runs at 05:00 UTC');
select is((select schedule from cron.job where jobname = 'broker-daily-0600'), '0 6 * * *', 'broker-daily-0600 runs at 06:00 UTC');
select is((select count(*)::int from cron.job where jobname like 'broker-daily-%' and command = 'select app.start_daily_broker_syncs();'), 2,
  'both daily entries call app.start_daily_broker_syncs()');
select is((select schedule from cron.job where jobname = 'broker-tick'), '* * * * *', 'broker-tick runs every minute');

update public.broker_connections set next_flex_fetch_not_before = null;
select is(app.start_daily_broker_syncs('2026-10-15 05:00:00+00'), 2, 'summer 05:00 UTC is 08:00 Sofia: both linked users are seeded');
select is(app.start_daily_broker_syncs('2026-10-15 05:00:00+00'), 0, 'a second call on the same Sofia date seeds nothing');
select is((select count(*)::int from public.broker_sync_runs where idempotency_key = 'a0000000-0000-4000-8000-00000000000a:daily:2026-10-15'), 1,
  'the idempotency key is <user>:daily:<Sofia date>');
select is((select statement_to from public.broker_sync_runs where idempotency_key = 'a0000000-0000-4000-8000-00000000000a:daily:2026-10-15'), '2026-10-14'::date,
  'the window ends the day before');
select is((select statement_from from public.broker_sync_runs where idempotency_key = 'a0000000-0000-4000-8000-00000000000a:daily:2026-10-15'), '2026-10-09'::date,
  'the window starts 5 days before last_statement_date');
select is((select statement_from from public.broker_sync_runs where idempotency_key = 'b0000000-0000-4000-8000-00000000000b:daily:2026-10-15'), null,
  'without a statement the run uses the query default period');
select is((select count(*)::int from public.broker_sync_runs where user_id = 'c0000000-0000-4000-8000-00000000000c'), 0, 'an unlinked user is never seeded');
select throws_ok($$insert into public.broker_sync_runs (user_id, connection_id, kind, state, idempotency_key)
                   values ('a0000000-0000-4000-8000-00000000000a', 'c1000000-0000-4000-8000-00000000000a', 'manual', 'queued', 'second-active')$$,
  '23505', null, 'a second active run for the same user is rejected');
update public.broker_sync_runs set state = 'done';
select is(app.start_daily_broker_syncs('2026-10-15 06:00:00+00'), 0, 'summer 06:00 UTC is 09:00 Sofia: the hour guard blocks it');
select is(app.start_daily_broker_syncs('2026-12-15 05:00:00+00'), 0, 'winter 05:00 UTC is 07:00 Sofia: the hour guard blocks it');
update public.broker_connections set next_flex_fetch_not_before = '2026-12-16 00:00:00+00' where user_id = 'b0000000-0000-4000-8000-00000000000b';
select is(app.start_daily_broker_syncs('2026-12-15 06:00:00+00'), 1, 'winter 06:00 UTC is 08:00 Sofia: only the user whose next fetch is due is seeded');
update public.broker_sync_runs set state = 'done';
update public.broker_connections set next_flex_fetch_not_before = null;
select is(app.start_daily_broker_syncs('2026-10-25 05:00:00+00'), 0, '2026-10-25 05:00 UTC is 07:00 Sofia (clocks changed): blocked');
select is(app.start_daily_broker_syncs('2026-10-25 06:00:00+00'), 2, '2026-10-25 06:00 UTC is 08:00 Sofia: seeded');
update public.broker_sync_runs set state = 'done';

-- ---------------------------------------------------------------- holders: app.holder, public.holds_security, public.monitored_holdings_for
insert into public.exchanges (code, name, country, timezone, currencies) values ('NMS', 'Nasdaq', 'United States', 'America/New_York', array['USD'])
  on conflict (code) do nothing;
insert into public.companies (id, name, name_normalized) values
  ('d0000000-0000-4000-8000-000000000001', 'Test Corp', 'test corp'), ('d0000000-0000-4000-8000-000000000002', 'Other Corp', 'other corp');
insert into public.securities (id, company_id, yahoo_symbol, exchange_code, currency, currency_major, quote_type) values
  ('e0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'TESTA', 'NMS', 'USD', 'USD', 'EQUITY'),
  ('e0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000002', 'TESTB', 'NMS', 'USD', 'USD', 'EQUITY');
update public.broker_positions set security_id = 'e0000000-0000-4000-8000-000000000001', signal_security_id = 'e0000000-0000-4000-8000-000000000001',
       match_status = 'matched_isin'
 where user_id = 'a0000000-0000-4000-8000-00000000000a' and conid = 100001;
insert into public.broker_positions (user_id, report_date, conid, symbol, currency, quantity, multiplier, security_id, signal_security_id, match_status) values
  ('b0000000-0000-4000-8000-00000000000b', '2026-10-14', 777, 'ZZZ', 'USD', 5, 1, 'e0000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000002', 'matched_isin');

select pg_temp.set_claims('a0000000-0000-4000-8000-00000000000a');
select is(public.holds_security('e0000000-0000-4000-8000-000000000001'), true, 'A holds the first security');
select is(public.holds_security('e0000000-0000-4000-8000-000000000002'), false, 'A does not hold the second security');
select is(app.holder('e0000000-0000-4000-8000-000000000001'), true, 'app.holder is based on broker_positions');
select pg_temp.set_claims('b0000000-0000-4000-8000-00000000000b');
select is(public.holds_security('e0000000-0000-4000-8000-000000000001'), false, 'B does not hold the first security');
select is((select count(*)::int from public.monitored_holdings_for('a0000000-0000-4000-8000-00000000000a')), 1, 'monitored_holdings_for lists the matched holding (service view)');
select is((select count(*)::int from app.held_signal_securities()), 2, 'held_signal_securities lists the signal security of every latest snapshot once');

-- ---------------------------------------------------------------- RLS as user A (authenticated)
select pg_temp.set_claims('a0000000-0000-4000-8000-00000000000a');
set local role authenticated;

select is((select count(*)::int from public.broker_connections), 1, 'A sees exactly one connection');
select is((select count(*)::int from public.broker_connections where user_id = 'b0000000-0000-4000-8000-00000000000b'), 0, 'A cannot see the connection of B');
select throws_ok($$select flex_token_ciphertext from public.broker_connections$$, '42501', null, 'the owner cannot select the ciphertext');
select throws_ok($$select flex_token_iv from public.broker_connections$$, '42501', null, 'the owner cannot select the IV');
select throws_ok($$select * from public.broker_connections$$, '42501', null, 'select * is refused because it includes secret columns');
select throws_ok($$select reference_code from public.broker_sync_runs$$, '42501', null, 'the Flex reference code is not selectable');
select is((select count(*)::int from public.broker_positions), 1, 'A sees only the own positions');
select is((select (select count(*) from public.broker_trades) + (select count(*) from public.broker_closed_lots)
               + (select count(*) from public.broker_cash_transactions) + (select count(*) from public.broker_fx_rates)
               + (select count(*) from public.broker_nav))::int, 10, 'A sees the own statement rows');
select is((select count(*)::int from public.broker_sync_runs where user_id = 'b0000000-0000-4000-8000-00000000000b'), 0, 'A cannot see the runs of B');
select throws_ok($$update public.broker_connections set status = 'unlinked'$$, '42501', null, 'clients cannot update the connection');
select throws_ok($$insert into public.broker_positions (user_id, report_date, conid, symbol, currency, quantity) values ('a0000000-0000-4000-8000-00000000000a', '2026-10-14', 1, 'X', 'USD', 1)$$,
  '42501', null, 'clients cannot insert positions');
select throws_ok($$delete from public.broker_trades$$, '42501', null, 'clients cannot delete trades');
select throws_ok($$update public.broker_sync_runs set state = 'done'$$, '42501', null, 'clients cannot update runs');
select throws_ok($$select * from app.claim_manual_refresh('a0000000-0000-4000-8000-00000000000a')$$, '42501', null, 'clients cannot call the service functions');
select is((select count(*)::int from public.monitored_holdings_for('a0000000-0000-4000-8000-00000000000a')), 1, 'A can list the own monitored holdings');
select is((select count(*)::int from public.monitored_holdings_for('b0000000-0000-4000-8000-00000000000b')), 0, 'A cannot list the holdings of B');

reset role;
select pg_temp.set_claims('b0000000-0000-4000-8000-00000000000b');
set local role authenticated;
select is((select count(*)::int from public.broker_connections where user_id = 'a0000000-0000-4000-8000-00000000000a'), 0, 'B cannot see the connection of A');
select is((select count(*)::int from public.broker_trades), 0, 'B sees no trades (none were ingested for B)');
select is((select count(*)::int from public.broker_positions), 1, 'B sees only the own position');
reset role;

select * from finish();
rollback;
