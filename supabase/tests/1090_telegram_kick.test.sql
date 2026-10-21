-- Migration 20261015009900: Telegram rows wake the dispatcher; telegram_queue_latest. 14 assertions.
begin;
create extension if not exists pgtap with schema extensions;
truncate public.todays_discounts, public.signal_episodes, public.universe_membership_events, public.universe_snapshots, public.scan_security_results, public.scan_events, public.scan_jobs, public.market_cap_snapshots, public.scan_runs restart identity cascade;
delete from digest_deliveries;
select plan(14);

insert into scan_runs (id, scan_date_local, status, settings_snapshot) values
  ('00000000-0000-0000-0001-000000000001', '2026-10-14', 'complete', '{}'),
  ('00000000-0000-0000-0001-000000000002', '2026-10-15', 'complete', '{}'),
  ('00000000-0000-0000-0001-000000000003', '2026-10-16', 'complete', '{}');
-- run 1: ready but old; run 2: ready and fresh; run 3: skipped (no Telegram row)
select public.notify_insert_public_digest('00000000-0000-0000-0001-000000000001', '{"items":[{"x":1}]}', 'h1', 'complete', 'ready', null, '2026-10-14');
select public.notify_insert_public_digest('00000000-0000-0000-0001-000000000002', '{"items":[{"x":1}]}', 'h2', 'complete', 'ready', null, '2026-10-15');
select public.notify_insert_public_digest('00000000-0000-0000-0001-000000000003', '{}', 'h3', 'complete', 'skipped', 'empty', '2026-10-16');
update digests set created_at = now() - interval '30 hours' where scan_run_id = '00000000-0000-0000-0001-000000000001';

-- pending_delivery_count ---------------------------------------------------------------------------------------------------------
select is(app.pending_delivery_count(), 2, 'due Telegram rows alone make the count positive');
update telegram_deliveries set next_attempt_at = now() + interval '1 hour';
select is(app.pending_delivery_count(), 0, 'a Telegram row due in the future is not counted');
update telegram_deliveries set next_attempt_at = now() - interval '1 minute', status = 'sent';
select is(app.pending_delivery_count(), 0, 'a sent Telegram row is not counted');
update telegram_deliveries set status = 'pending';
select is(app.pending_delivery_count(), 2, 'pending and due rows are counted again');
select is(has_function_privilege('service_role', 'app.pending_delivery_count()', 'execute'), true, 'service_role keeps execute on the count');
select is(has_function_privilege('authenticated', 'app.pending_delivery_count()', 'execute'), false, 'signed-in users cannot run the count');

-- telegram_queue_latest -----------------------------------------------------------------------------------------------------------
select is(has_function_privilege('authenticated', 'public.telegram_queue_latest()', 'execute'), false, 'signed-in users cannot queue');
select is(has_function_privilege('service_role', 'public.telegram_queue_latest()', 'execute'), true, 'service_role can queue');

select is((public.telegram_queue_latest() ->> 'scan_date'), '2026-10-15', 'the latest ready digest younger than 24 hours is chosen');

update telegram_deliveries set status = 'failed', attempts = 5, last_error = 'x', next_attempt_at = now() + interval '1 hour'
 where digest_id = (select id from digests where scan_run_id = '00000000-0000-0000-0001-000000000002');
select is((public.telegram_queue_latest() ->> 'queued')::boolean, true, 'a failed row is queued again');
select is((select (status, attempts, next_attempt_at <= now())::text from telegram_deliveries
            where digest_id = (select id from digests where scan_run_id = '00000000-0000-0000-0001-000000000002')),
  '(pending,0,t)', 'it is reset to pending, 0 attempts, due now');

update telegram_deliveries set status = 'sent' where digest_id = (select id from digests where scan_run_id = '00000000-0000-0000-0001-000000000002');
select is(public.telegram_queue_latest() ->> 'reason', 'already_sent', 'a sent digest is left alone');

delete from telegram_deliveries where digest_id = (select id from digests where scan_run_id = '00000000-0000-0000-0001-000000000002');
select public.telegram_queue_latest();
select is((select status from telegram_deliveries where digest_id = (select id from digests where scan_run_id = '00000000-0000-0000-0001-000000000002')),
  'pending', 'a digest without a row gets a pending one');

update digests set created_at = now() - interval '30 hours';
select is(public.telegram_queue_latest() ->> 'reason', 'no_ready_digest', 'no ready digest younger than 24 hours: nothing to send');

select * from finish();
rollback;
