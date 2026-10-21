-- Migration 20261015010000: operator push actions (push_claim_test, push_queue_latest). 22 assertions.
begin;
create extension if not exists pgtap with schema extensions;
truncate public.todays_discounts, public.signal_episodes, public.universe_membership_events, public.universe_snapshots, public.scan_security_results, public.scan_events, public.scan_jobs, public.market_cap_snapshots, public.scan_runs restart identity cascade;
delete from digest_deliveries;
delete from push_subscriptions;
select plan(22);

insert into auth.users (id, email, email_confirmed_at, instance_id, aud, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'a1@example.com', now(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');

select is(has_function_privilege('authenticated', 'public.push_claim_test()', 'execute'), false, 'signed-in users cannot claim a push test');
select is(has_function_privilege('service_role', 'public.push_claim_test()', 'execute'), true, 'service_role can claim a push test');
select is(has_function_privilege('authenticated', 'public.push_queue_latest()', 'execute'), false, 'signed-in users cannot queue pushes');
select is(has_function_privilege('service_role', 'public.push_queue_latest()', 'execute'), true, 'service_role can queue pushes');

-- push_claim_test ------------------------------------------------------------------------------------------------------------------
select is(public.notify_subscribe(null, 'https://e/anon1', 'k', 'a', null, 5), 'ok', 'device subscribed');
select is(public.notify_subscribe('00000000-0000-0000-0000-0000000000a1', 'https://e/user1', 'k', 'a', null, 5), 'ok', 'device subscribed');
select is(public.notify_subscribe(null, 'https://e/anon2', 'k', 'a', null, 5), 'ok', 'device subscribed');
update push_subscriptions set revoked_at = now() where endpoint = 'https://e/anon2';

select is(jsonb_array_length(public.push_claim_test() -> 'devices'), 2, 'every active device, signed in or not, is a target; revoked ones are not');
select is(public.push_claim_test() ->> 'status', 'rate_limited', 'a second claim inside five minutes is rate limited');
select ok((public.push_claim_test() ->> 'retry_after_seconds')::int between 1 and 300, 'the answer says how long to wait');
update push_operator_runs set last_run_at = now() - interval '6 minutes' where action = 'push_test';
select is(public.push_claim_test() ->> 'status', 'ok', 'after five minutes the claim works again');

-- push_queue_latest ----------------------------------------------------------------------------------------------------------------
insert into scan_runs (id, scan_date_local, status, settings_snapshot) values
  ('00000000-0000-0000-0001-000000000001', '2026-10-14', 'complete', '{}'),
  ('00000000-0000-0000-0001-000000000002', '2026-10-15', 'complete', '{}');
select is(public.push_queue_latest() ->> 'reason', 'no_ready_digest', 'no digest: nothing to queue');

select public.notify_insert_public_digest('00000000-0000-0000-0001-000000000001', '{"items":[{"x":1}]}', 'h1', 'complete', 'ready', null, '2026-10-14');
update digests set created_at = now() - interval '30 hours';
select is(public.push_queue_latest() ->> 'reason', 'no_ready_digest', 'a digest older than 24 hours is ignored');
delete from digests;

-- anon1 is the one active anonymous device when the digest is created; anon3 and anon4 subscribe afterwards
select public.notify_insert_public_digest('00000000-0000-0000-0001-000000000002', '{"items":[{"x":1}]}', 'h2', 'complete', 'ready', null, '2026-10-15');
select is(public.notify_subscribe(null, 'https://e/anon3', 'k', 'a', null, 5), 'ok', 'device subscribed');
select is(public.notify_subscribe(null, 'https://e/anon4', 'k', 'a', null, 5, false, false), 'ok', 'device subscribed');
select is((select count(*)::int from digest_deliveries), 1, 'the digest had one delivery (anon1) when it was created');

select is((public.push_queue_latest() ->> 'queued')::int, 1, 'a device without a delivery gets one; anon4 has the discounts topic off');
select is((select count(*)::int from digest_deliveries), 2, 'two deliveries now');
select is((select d.idempotency_key from digest_deliveries d join push_subscriptions s on s.id = d.subscription_id where s.endpoint = 'https://e/anon3'),
  'digest:discounts:public:' || (select id::text from push_subscriptions where endpoint = 'https://e/anon3') || ':2026-10-15', 'the idempotency key has the public digest format');

update digest_deliveries set status = 'sent' where subscription_id = (select id from push_subscriptions where endpoint = 'https://e/anon1');
update digest_deliveries set status = 'failed', attempts = 5, last_error = 'x', next_attempt_at = now() + interval '1 hour'
 where subscription_id = (select id from push_subscriptions where endpoint = 'https://e/anon3');
select is(public.push_queue_latest() ->> 'already_sent', '1', 'sent deliveries are counted and left alone');
select is((select (status, attempts, next_attempt_at <= now())::text from digest_deliveries
            where subscription_id = (select id from push_subscriptions where endpoint = 'https://e/anon3')), '(pending,0,t)',
  'a failed delivery is reset to pending, 0 attempts, due now');
select is((select status::text from digest_deliveries where subscription_id = (select id from push_subscriptions where endpoint = 'https://e/anon1')),
  'sent', 'the sent delivery stays sent');

select * from finish();
rollback;
