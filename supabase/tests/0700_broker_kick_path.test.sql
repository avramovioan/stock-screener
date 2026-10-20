begin;
create extension if not exists pgtap with schema extensions;
select plan(5);

-- P5b: broker-sync has exactly one kick path, the dedicated `broker-tick` cron entry (app.kick_broker_sync).
-- app.kick_workers (worker-tick, notify-dispatch) must never start broker-sync, otherwise one due run could be driven by two invocations.
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values
  ('a7000000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'kick@example.test', now(), now());
insert into public.broker_connections (id, user_id, status, flex_token_ciphertext, flex_token_iv, key_version, query_id) values
  ('c7000000-0000-4000-8000-00000000000a', 'a7000000-0000-4000-8000-00000000000a', 'linked', '\x0102'::bytea, '\x0a0b'::bytea, 1, '777');
insert into public.broker_sync_runs (user_id, connection_id, kind, state, idempotency_key) values
  ('a7000000-0000-4000-8000-00000000000a', 'c7000000-0000-4000-8000-00000000000a', 'daily', 'queued', 'kick-path-test');
-- a due scan job so that kick_workers has real work of its own
insert into scan_runs (id, scan_date_local, settings_snapshot) values ('00000000-0000-0000-0000-0000000000e7', date '2030-01-01' + 97, '{}');
insert into scan_jobs (scan_run_id, stage, key, status, not_before) values ('00000000-0000-0000-0000-0000000000e7', 'compute', 'k', 'queued', now() - interval '1 minute');

delete from vault.secrets where name in ('project_url', 'worker_tick_secret');
select vault.create_secret('http://example.invalid', 'project_url');
select vault.create_secret('dummy-secret-value-7f3a9c', 'worker_tick_secret');
create temp table _q0 as select count(*)::int as n from net.http_request_queue;

select app.kick_workers();
select is((select count(*)::int from net.http_request_queue), (select n + 1 from _q0), 'kick_workers enqueues only the worker-tick request although a broker run is due');
select is((select count(*)::int from net.http_request_queue where url like '%/broker-sync'), 0, 'kick_workers never calls broker-sync');
select is(pg_get_functiondef('app.kick_workers()'::regprocedure) like '%broker%', false, 'the kick_workers body has no broker branch');

select app.kick_broker_sync();
select is((select count(*)::int from net.http_request_queue where url like '%/broker-sync'), 1, 'kick_broker_sync enqueues exactly one broker-sync request');
select is((select count(*)::int from net.http_request_queue), (select n + 2 from _q0), 'and nothing else');

select * from finish();
rollback;
