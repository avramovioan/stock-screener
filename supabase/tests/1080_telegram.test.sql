-- Migration 20261015009800: one Telegram delivery per ready public digest, claimed and completed by notify-dispatch. 22 assertions.
begin;
create extension if not exists pgtap with schema extensions;
truncate public.todays_discounts, public.signal_episodes, public.universe_membership_events, public.universe_snapshots, public.scan_security_results, public.scan_events, public.scan_jobs, public.market_cap_snapshots, public.scan_runs restart identity cascade;
select plan(22);

create function pg_temp.uid(p_kind int, p_i int) returns uuid language sql immutable as $$
  select ('00000000-0000-0000-' || lpad(p_kind::text, 4, '0') || '-' || lpad(p_i::text, 12, '0'))::uuid
$$;

-- schema -----------------------------------------------------------------------------------------------------------------------
select has_table('public', 'telegram_deliveries', 'the Telegram deliveries table exists');
select col_is_unique('public', 'telegram_deliveries', 'digest_id', 'one delivery per digest');
select is((select relrowsecurity from pg_class where oid = 'public.telegram_deliveries'::regclass), true, 'row level security is on');
select is(has_table_privilege('authenticated', 'public.telegram_deliveries', 'select'), false, 'signed-in users cannot read it');
select is(has_table_privilege('anon', 'public.telegram_deliveries', 'select'), false, 'visitors cannot read it');

-- creation: only a ready public digest gets a row -------------------------------------------------------------------------------
insert into scan_runs (id, scan_date_local, status, settings_snapshot) values
  (pg_temp.uid(3, 1), '2026-10-14', 'complete', '{}'),
  (pg_temp.uid(3, 2), '2026-10-15', 'complete', '{}'),
  (pg_temp.uid(3, 3), '2026-10-16', 'complete', '{}');
select isnt(public.notify_insert_public_digest(pg_temp.uid(3, 1), '{"kind":"discounts","items":[{"x":1}]}', 'h1', 'complete', 'ready', null, '2026-10-14'), null,
  'a ready public digest is created');
select is((select count(*)::int from telegram_deliveries t join digests g on g.id = t.digest_id where g.scan_run_id = pg_temp.uid(3, 1) and t.status = 'pending'), 1,
  'it has exactly one pending Telegram delivery, even with no push device');
select is(public.notify_insert_public_digest(pg_temp.uid(3, 1), '{"kind":"discounts","items":[{"x":1}]}', 'h1', 'complete', 'ready', null, '2026-10-14'), null, 'a repeat is a no-op');
select is((select count(*)::int from telegram_deliveries), 1, 'a repeat adds no second Telegram delivery');
select isnt(public.notify_insert_public_digest(pg_temp.uid(3, 2), '{}', 'h', 'complete', 'skipped', 'empty', '2026-10-15'), null, 'an empty public digest is recorded');
select is((select count(*)::int from telegram_deliveries), 1, 'an empty public digest sends nothing to Telegram');

-- claim ----------------------------------------------------------------------------------------------------------------------------
select is((select count(*)::int from public.notify_telegram_claim(5)), 1, 'the due delivery is claimed');
select is((select attempts from telegram_deliveries limit 1), 1, 'the claim counts the attempt');
select is((select count(*)::int from public.notify_telegram_claim(5)), 0, 'a claimed delivery is leased: it is not claimed again at once');
update telegram_deliveries set next_attempt_at = now() - interval '1 second';
select is((select c->>'scanDate' from public.notify_telegram_claim(5) c), '2026-10-14', 'the claim carries the scan date and the digest content');

-- complete: retry, sent, and a settled delivery stays settled ---------------------------------------------------------------------------
select is((select id from telegram_deliveries limit 1) is not null, true, 'a delivery to complete');
select public.notify_telegram_complete((select id from telegram_deliveries limit 1), 'pending', 'telegram_429', null, 30);
select is((select status || ':' || last_error from telegram_deliveries limit 1), 'pending:telegram_429', 'a retry stays pending with the error code');
select is((select next_attempt_at > now() + interval '20 seconds' from telegram_deliveries limit 1), true, 'and is due again after the delay');
select public.notify_telegram_complete((select id from telegram_deliveries limit 1), 'sent', null, 4242, null);
select is((select status || ':' || message_id::text || ':' || (sent_at is not null)::text from telegram_deliveries limit 1), 'sent:4242:true', 'sent records the message id and the time');
select public.notify_telegram_complete((select id from telegram_deliveries limit 1), 'failed', 'late', null, null);
select is((select status from telegram_deliveries limit 1), 'sent', 'a settled delivery is never changed again');

-- retention: the digest purge takes the delivery with it -------------------------------------------------------------------------------
insert into digests (id, scan_run_id, kind, user_id, content, content_hash, cutoff_reason, created_at)
values (pg_temp.uid(6, 2), pg_temp.uid(3, 3), 'discounts', null, '{}', 'h', 'complete', now() - interval '200 days');
insert into telegram_deliveries (digest_id) values (pg_temp.uid(6, 2));
select is((app.purge_notifications(100)->>'digests')::int, 1, 'one old public digest is purged');
select is((select count(*)::int from telegram_deliveries where digest_id = pg_temp.uid(6, 2)), 0, 'its Telegram delivery goes with it');

select * from finish();
rollback;
