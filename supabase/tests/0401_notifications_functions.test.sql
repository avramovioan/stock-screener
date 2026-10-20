begin;
create extension if not exists pgtap with schema extensions;
truncate public.todays_discounts, public.signal_episodes, public.universe_membership_events, public.universe_snapshots, public.scan_security_results, public.scan_events, public.scan_jobs, public.market_cap_snapshots, public.scan_runs restart identity cascade;
select plan(27);

insert into auth.users (id, email, email_confirmed_at, instance_id, aud, role)
values ('00000000-0000-0000-0000-0000000000a1', 'a@example.test', now(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');
insert into scan_runs (id, scan_date_local, status, settings_snapshot) values
  ('00000000-0000-0000-0000-0000000000c1', '2026-07-15', 'running', '{}'),   -- summer
  ('00000000-0000-0000-0000-0000000000c2', '2026-01-15', 'running', '{}');   -- winter

-- cutoff_digests: Sofia hour = 13 guard --------------------------------------------------------------
select is(app.cutoff_digests('2026-07-15 10:00:00+00'), 1, 'summer 10:00Z is 13:00 Sofia: seeds the cut-off job');
select is((select count(*)::int from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000c1' and stage = 'digest' and key = 'digest:cutoff'), 1, 'digest:cutoff job exists');
select is((select status::text from scan_runs where id = '00000000-0000-0000-0000-0000000000c1'), 'partial', 'a running scan becomes partial at the cut-off');
select is(app.cutoff_digests('2026-07-15 10:00:00+00'), 1, 'a second call finds the run again');
select is((select count(*)::int from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000c1' and key = 'digest:cutoff'), 1, '... but never creates a second job (ON CONFLICT DO NOTHING)');
select is(app.cutoff_digests('2026-07-15 11:00:00+00'), 0, 'summer 11:00Z is 14:00 Sofia: guard returns 0');
select is(app.cutoff_digests('2026-07-15 09:00:00+00'), 0, 'summer 09:00Z is 12:00 Sofia: guard returns 0');
select is(app.cutoff_digests('2026-01-15 11:00:00+00'), 1, 'winter 11:00Z is 13:00 Sofia: seeds the job');
select is(app.cutoff_digests('2026-01-15 10:00:00+00'), 0, 'winter 10:00Z is 12:00 Sofia: guard returns 0');

update scan_runs set digests_created_at = now() where id = '00000000-0000-0000-0000-0000000000c2';
select is(app.cutoff_digests('2026-01-15 11:00:00+00'), 0, 'digests already created: no cut-off job');
update scan_runs set digests_created_at = null, status = 'complete' where id = '00000000-0000-0000-0000-0000000000c2';
select is(app.cutoff_digests('2026-01-15 11:00:00+00'), 0, 'a complete scan needs no cut-off');

-- pending_delivery_count ----------------------------------------------------------------------------
insert into digests (id, scan_run_id, kind, user_id, content, content_hash, cutoff_reason)
values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', 'discounts', '00000000-0000-0000-0000-0000000000a1', '{}', 'h', 'complete');
insert into digest_deliveries (id, digest_id, user_id, channel, idempotency_key, next_attempt_at) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'push', 'k1', now() - interval '1 minute'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'email', 'k2', now() + interval '1 hour');
select is(app.pending_delivery_count(), 1, 'only due pending deliveries are counted');

-- claim_deliveries: lease, attempts, no double claim ------------------------------------------------
select is((select count(*)::int from app.claim_deliveries(10)), 1, 'claims the one due delivery');
select is((select attempts from digest_deliveries where id = '00000000-0000-0000-0000-0000000000f1'), 1, 'attempts incremented at claim');
select ok((select next_attempt_at from digest_deliveries where id = '00000000-0000-0000-0000-0000000000f1') > now() + interval '9 minutes', 'the lease moves next_attempt_at about 10 minutes ahead');
select is((select count(*)::int from app.claim_deliveries(10)), 0, 'a leased delivery is not claimed twice');
select is(app.pending_delivery_count(), 0, 'a leased delivery is no longer counted as due');

-- consume_quota_capped -----------------------------------------------------------------------------
select is(app.consume_quota_capped('llm', 'day_cap', 1, 'day', 2), true, 'quota 1 of 2');
select is(app.consume_quota_capped('llm', 'day_cap', 1, 'day', 2), true, 'quota 2 of 2');
select is(app.consume_quota_capped('llm', 'day_cap', 1, 'day', 2), false, 'quota 3 of 2 refused');


-- notify_subscribe cap and push test throttle ---------------------------------------------------------
select is(public.notify_subscribe('00000000-0000-0000-0000-0000000000a1', 'https://e/1', 'k', 'a', null, 2), 'ok', 'subscribe 1 of 2');
select is(public.notify_subscribe('00000000-0000-0000-0000-0000000000a1', 'https://e/2', 'k', 'a', null, 2), 'ok', 'subscribe 2 of 2');
select is(public.notify_subscribe('00000000-0000-0000-0000-0000000000a1', 'https://e/3', 'k', 'a', null, 2), 'too_many', 'subscribe 3 of 2 refused');
select is(public.notify_subscribe('00000000-0000-0000-0000-0000000000a1', 'https://e/2', 'k2', 'a', null, 2), 'ok', 're-subscribing a known endpoint is not capped');
select is(public.notify_claim_push_test('00000000-0000-0000-0000-0000000000a1') and not public.notify_claim_push_test('00000000-0000-0000-0000-0000000000a1'), true, 'push test: first allowed, second within a minute refused');
-- cron jobs ------------------------------------------------------------------------------------------
select is((select schedule from cron.job where jobname = 'digest-cutoff-1000'), '0 10 * * *', 'cron digest-cutoff-1000');
select is((select schedule from cron.job where jobname = 'digest-cutoff-1100'), '0 11 * * *', 'cron digest-cutoff-1100');

select * from finish();
rollback;
