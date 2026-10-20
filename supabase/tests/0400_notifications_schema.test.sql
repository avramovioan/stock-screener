begin;
create extension if not exists pgtap with schema extensions;
truncate public.todays_discounts, public.signal_episodes, public.universe_membership_events, public.universe_snapshots, public.scan_security_results, public.scan_events, public.scan_jobs, public.market_cap_snapshots, public.scan_runs restart identity cascade;
select plan(26);

-- fixtures -------------------------------------------------------------------------------------
insert into auth.users (id, email, email_confirmed_at, instance_id, aud, role)
values ('00000000-0000-0000-0000-0000000000a1', 'a@example.test', now(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
       ('00000000-0000-0000-0000-0000000000b2', 'b@example.test', now(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');
insert into scan_runs (id, scan_date_local, status, settings_snapshot)
values ('00000000-0000-0000-0000-0000000000c1', '2026-07-15', 'complete', '{}');
insert into notification_preferences (user_id, push_enabled) values
  ('00000000-0000-0000-0000-0000000000a1', true), ('00000000-0000-0000-0000-0000000000b2', true);
insert into push_subscriptions (id, user_id, endpoint, p256dh, auth) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', 'https://push.example.test/a', 'k', 's'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000b2', 'https://push.example.test/b', 'k', 's');
insert into digests (id, scan_run_id, kind, user_id, content, content_hash, cutoff_reason) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', 'discounts', '00000000-0000-0000-0000-0000000000a1', '{}', 'h', 'complete'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000c1', 'discounts', '00000000-0000-0000-0000-0000000000b2', '{}', 'h', 'complete');
insert into digest_items (digest_id, user_id, ref_type, ref_id) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'episode', '00000000-0000-0000-0000-0000000000f1');
insert into digest_deliveries (digest_id, user_id, channel, idempotency_key) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'push', 'k1'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000b2', 'push', 'k2');

-- uniques (idempotency, spec 7.11) ----------------------------------------------------------------
select throws_ok($$insert into digests (scan_run_id, kind, user_id, content, content_hash, cutoff_reason)
  values ('00000000-0000-0000-0000-0000000000c1','discounts','00000000-0000-0000-0000-0000000000a1','{}','h','complete')$$,
  '23505', null, 'digests UNIQUE (scan_run_id, kind, user_id)');
select throws_ok($$insert into digest_items (digest_id, user_id, ref_type, ref_id)
  values ('00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000a1','episode','00000000-0000-0000-0000-0000000000f1')$$,
  '23505', null, 'digest_items UNIQUE (user_id, ref_type, ref_id)');
select throws_ok($$insert into digest_deliveries (digest_id, user_id, channel, idempotency_key)
  values ('00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000a1','push','k9')$$,
  '23505', null, 'digest_deliveries UNIQUE (digest_id, user_id, channel)');
select throws_ok($$insert into push_subscriptions (user_id, endpoint, p256dh, auth)
  values ('00000000-0000-0000-0000-0000000000b2','https://push.example.test/a','k','s')$$,
  '23505', null, 'push_subscriptions endpoint is UNIQUE');
select throws_ok($$insert into email_events (svix_id, type) values ('msg_1','email.sent'), ('msg_1','email.sent')$$,
  '23505', null, 'email_events svix_id is UNIQUE');
select col_default_is('notification_preferences', 'digest_modes', '{worldwide}'::universe_mode[], 'digest_modes defaults to worldwide');
select col_default_is('notification_preferences', 'push_enabled', 'false', 'push is opt-in');
select col_default_is('notification_preferences', 'email_enabled', 'false', 'email is opt-in');
select enum_has_labels('delivery_status', array['pending','sent','failed','skipped','bounced'], 'delivery_status labels');
select enum_has_labels('delivery_channel', array['push','email'], 'delivery_channel labels');

-- RLS: user A sees only own rows ------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
select is((select count(*)::int from notification_preferences), 1, 'A sees only own preferences');
select is((select count(*)::int from digests), 1, 'A sees only own digests');
select is((select count(*)::int from digest_items), 1, 'A sees only own digest items');
select is((select count(*)::int from digest_deliveries), 1, 'A sees only own deliveries');
select is((select count(*)::int from push_subscriptions), 1, 'A sees only own subscriptions');
select throws_ok($$select p256dh from push_subscriptions$$, '42501', null, 'push key columns are not selectable');
select throws_ok($$select endpoint from push_subscriptions$$, '42501', null, 'endpoint is not selectable');
select throws_ok($$insert into push_subscriptions (user_id, endpoint, p256dh, auth)
  values ('00000000-0000-0000-0000-0000000000a1','https://169.254.169.254/x','k','s')$$,
  '42501', null, 'clients cannot insert subscriptions (SSRF guard: push-subscribe validates)');
select lives_ok($$update notification_preferences set email_enabled = true where user_id = '00000000-0000-0000-0000-0000000000a1'$$,
  'A can update own preferences');
select lives_ok($$update notification_preferences set send_empty = true where user_id = '00000000-0000-0000-0000-0000000000b2'$$,
  'A updating B preferences affects zero rows (RLS filters)');
select throws_ok($$update notification_preferences set email_unsubscribed_at = now() where user_id = '00000000-0000-0000-0000-0000000000a1'$$,
  '42501', null, 'a client cannot set email_unsubscribed_at (only clear it)');
select throws_ok($$update notification_preferences set email_bounced_at = null where user_id = '00000000-0000-0000-0000-0000000000a1'$$,
  '42501', null, 'email_bounced_at is server-set (no column privilege)');
select lives_ok($$delete from push_subscriptions$$, 'A can delete own subscriptions');

reset role;
select is((select send_empty from notification_preferences where user_id = '00000000-0000-0000-0000-0000000000b2'), false, 'B preferences were not changed by A');
select is((select count(*)::int from push_subscriptions where user_id = '00000000-0000-0000-0000-0000000000a1'), 0, 'A subscription deleted');
select is((select count(*)::int from push_subscriptions where user_id = '00000000-0000-0000-0000-0000000000b2'), 1, 'B subscription survived');

select * from finish();
rollback;
