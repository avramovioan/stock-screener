-- Migration 20261015009700: any device can subscribe without an account; a public "new on the list" digest goes to anonymous
-- devices; user digests and holdings alerts stay with signed-in users. 44 assertions.
begin;
create extension if not exists pgtap with schema extensions;
truncate public.todays_discounts, public.signal_episodes, public.universe_membership_events, public.universe_snapshots, public.scan_security_results, public.scan_events, public.scan_jobs, public.market_cap_snapshots, public.scan_runs restart identity cascade;
select plan(44);

create function pg_temp.uid(p_kind int, p_i int) returns uuid language sql immutable as $$
  select ('00000000-0000-0000-' || lpad(p_kind::text, 4, '0') || '-' || lpad(p_i::text, 12, '0'))::uuid
$$;

insert into auth.users (id, email, email_confirmed_at, instance_id, aud, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'a1@example.com', now(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b2', 'b2@example.com', now(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');

-- schema ---------------------------------------------------------------------------------------------------------------------
select col_is_null('public', 'push_subscriptions', 'user_id', 'a subscription may belong to nobody');
select col_default_is('public', 'push_subscriptions', 'topic_discounts', 'true', 'discounts is on by default');
select col_default_is('public', 'push_subscriptions', 'topic_portfolio', 'false', 'portfolio is off by default');
select throws_ok($$insert into push_subscriptions (user_id, endpoint, p256dh, auth, topic_portfolio) values (null, 'https://e/x', 'k', 'a', true)$$,
  '23514', null, 'the portfolio topic needs a user');
select col_is_null('public', 'digests', 'user_id', 'a digest may belong to nobody (the public digest)');
select col_is_null('public', 'digest_deliveries', 'user_id', 'a delivery may target a device instead of a user');
select has_column('public', 'digest_deliveries', 'subscription_id', 'deliveries can point at a subscription');

-- notify_subscribe: anonymous, user, rebinding, cap -----------------------------------------------------------------------------
select is(public.notify_subscribe(null, 'https://e/anon1', 'k', 'a', 'UA', 2), 'ok', 'an anonymous device subscribes with the default topics');
select is((select user_id is null and topic_discounts and not topic_portfolio from push_subscriptions where endpoint = 'https://e/anon1'), true,
  'anonymous row: no user, discounts on, portfolio off');
select is(public.notify_subscribe(null, 'https://e/anon2', 'k', 'a', null, 2, true, true), 'ok', 'anonymous subscribe asks for portfolio');
select is((select topic_portfolio from push_subscriptions where endpoint = 'https://e/anon2'), false, 'portfolio is forced off without a user');
select is(public.notify_subscribe(null, 'https://e/anon3', 'k', 'a', null, 2), 'ok', 'anonymous rows have no per-user cap');
select is(public.notify_subscribe('00000000-0000-0000-0000-0000000000a1', 'https://e/u1', 'k', 'a', null, 1, true, true), 'ok', 'a user subscribes with both topics');
select is((select topic_discounts and topic_portfolio from push_subscriptions where endpoint = 'https://e/u1'), true, 'user row keeps both topics');
select is(public.notify_subscribe('00000000-0000-0000-0000-0000000000a1', 'https://e/u2', 'k', 'a', null, 1), 'too_many', 'the per-user cap still applies');
select is((select push_enabled from notification_preferences where user_id = '00000000-0000-0000-0000-0000000000a1'), true,
  'subscribing a signed-in device turns the user digest push on');
select is(public.notify_subscribe('00000000-0000-0000-0000-0000000000b2', 'https://e/anon1', 'k2', 'a', null, 1, true, true), 'ok', 'a signed-in call on a known endpoint binds it to the user');
select is((select user_id from push_subscriptions where endpoint = 'https://e/anon1'), '00000000-0000-0000-0000-0000000000b2'::uuid, 'the row now belongs to the user');
select is(public.notify_subscribe(null, 'https://e/anon1', 'k3', 'a', null, 1, true, true), 'ok', 'a call without a user makes it anonymous again');
select is((select user_id is null and not topic_portfolio from push_subscriptions where endpoint = 'https://e/anon1'), true, 'anonymous again, portfolio off');

-- update / test claim -------------------------------------------------------------------------------------------------------------
select is(public.notify_update_subscription('00000000-0000-0000-0000-0000000000a1', 'https://e/anon3', false, true), true, 'update binds the user and sets the topics');
select is((select user_id = '00000000-0000-0000-0000-0000000000a1'::uuid and not topic_discounts and topic_portfolio from push_subscriptions where endpoint = 'https://e/anon3'), true,
  'update stored user and topics');
select is(public.notify_update_subscription(null, 'https://e/anon3', true, true), true, 'update without a user');
select is((select user_id is null and topic_discounts and not topic_portfolio from push_subscriptions where endpoint = 'https://e/anon3'), true, 'portfolio off after an anonymous update');
select is(public.notify_update_subscription(null, 'https://e/nope', true, false), false, 'update of an unknown endpoint finds nothing');
select is(public.notify_claim_endpoint_test('https://e/anon3')->>'status', 'ok', 'the first test push of an endpoint is allowed');
select is(public.notify_claim_endpoint_test('https://e/anon3')->>'status', 'rate_limited', 'a second one within a minute is refused');
select is(public.notify_claim_endpoint_test('https://e/none')->>'status', 'not_found', 'an unknown endpoint is not_found');

-- the public digest -----------------------------------------------------------------------------------------------------------------
insert into push_subscriptions (id, user_id, endpoint, p256dh, auth, topic_discounts) values
  (pg_temp.uid(9, 1), null, 'https://d/1', 'k', 'a', true),
  (pg_temp.uid(9, 2), null, 'https://d/2', 'k', 'a', false),
  (pg_temp.uid(9, 3), null, 'https://d/3', 'k', 'a', true);
update push_subscriptions set revoked_at = now(), revoke_reason = 'gone' where id = pg_temp.uid(9, 3);
update push_subscriptions set topic_discounts = false where endpoint in ('https://e/anon1', 'https://e/anon2', 'https://e/anon3');
insert into scan_runs (id, scan_date_local, status, settings_snapshot) values (pg_temp.uid(3, 1), '2026-10-14', 'complete', '{}');

select isnt(public.notify_insert_public_digest(pg_temp.uid(3, 1), '{"kind":"discounts","items":[{"x":1}]}', 'h1', 'complete', 'ready', null, '2026-10-14'), null,
  'the public digest is created once per run');
select is(public.notify_insert_public_digest(pg_temp.uid(3, 1), '{"kind":"discounts","items":[{"x":1}]}', 'h1', 'complete', 'ready', null, '2026-10-14'), null,
  'a second call for the same run is a no-op');
select is((select array_agg(s.endpoint order by s.endpoint) from digest_deliveries d join push_subscriptions s on s.id = d.subscription_id), array['https://d/1'],
  'one delivery per active anonymous device with the discounts topic; revoked and opted-out devices get none');
select is((select count(*)::int from digest_deliveries where user_id is not null), 0, 'user rows are not part of the public digest');
select is((select (c->>'subscriptionId')::uuid from app.claim_deliveries(5) c), pg_temp.uid(9, 1), 'the claim carries the subscription id');
select is((select count(*)::int from public.notify_device_subscription(pg_temp.uid(9, 1))), 1, 'an anonymous active device resolves to its push target');
select is((select count(*)::int from public.notify_device_subscription(pg_temp.uid(9, 2))), 0, 'an opted-out device resolves to nothing');
insert into scan_runs (id, scan_date_local, status, settings_snapshot) values (pg_temp.uid(3, 2), '2026-10-15', 'complete', '{}');
select isnt(public.notify_insert_public_digest(pg_temp.uid(3, 2), '{}', 'h', 'complete', 'skipped', 'empty', '2026-10-15'), null,
  'an empty public digest is recorded once');
select is((select count(*)::int from digest_deliveries d join digests g on g.id = d.digest_id where g.scan_run_id = pg_temp.uid(3, 2)), 0,
  'an empty public digest has no deliveries: nothing is sent to anonymous devices');

-- user digests keep working ---------------------------------------------------------------------------------------------------------------
select is((select has_discounts_push and has_portfolio_push from public.notify_digest_users() where user_id = '00000000-0000-0000-0000-0000000000a1'), true,
  'the digest user list tells which kinds the user has a device for');

-- candidates: the public rule is the user rule without the user's country filter and without per-user dedupe ----------------------------------------
insert into companies (id, name, name_normalized, country) select pg_temp.uid(1, i), 'Company ' || i, 'company ' || i, case when i = 2 then 'France' else 'United States' end from generate_series(1, 2) i;
insert into securities (id, company_id, yahoo_symbol, exchange_code, currency, currency_major, quote_type, is_canonical)
select pg_temp.uid(2, i), pg_temp.uid(1, i), 'S' || i, 'NMS', 'USD', 'USD', 'EQUITY', true from generate_series(1, 2) i;
insert into signal_episodes (id, security_id, company_id, kind, mode, threshold_line, opened_scan_run_id, opened_session_date, opened_close, opened_line_value, open_reason, last_evaluated_session_date)
select pg_temp.uid(4, i), pg_temp.uid(2, i), pg_temp.uid(1, i), 'discount', 'worldwide', '-3', pg_temp.uid(3, 1), '2026-10-12', 9, 10, 'new_entry', '2026-10-12' from generate_series(1, 2) i;
insert into todays_discounts (scan_run_id, mode, security_id, company_id, episode_id, is_new_episode, rank, close, currency, session_date, threshold_line, lower_line_end, channel, trend_ok, eligibility,
                              operational_category, category_reason, data_freshness, display_order, withheld)
select pg_temp.uid(3, 1), 'worldwide', pg_temp.uid(2, i), pg_temp.uid(1, i), pg_temp.uid(4, i), true, i, 85, 'USD', '2026-10-12', '-3', 90, '{"end":{"lower1":90,"lower2":80}}', true, '{}', 'pending', 'research_pending', 'fresh', i, false
  from generate_series(1, 2) i;
update notification_preferences set digest_country_filter = 'France' where user_id = '00000000-0000-0000-0000-0000000000a1';
select is((select array_agg(rank order by rank) from public.notify_discount_candidates(pg_temp.uid(3, 1), '00000000-0000-0000-0000-0000000000a1', false)), array[2],
  'the user rule is unchanged: the user''s country filter applies');
select is((select array_agg(rank order by rank) from public.notify_public_discount_candidates(pg_temp.uid(3, 1))), array[1, 2], 'the public rule ignores any user''s country filter');
insert into digests (id, scan_run_id, kind, user_id, content, content_hash, cutoff_reason) values (pg_temp.uid(6, 1), pg_temp.uid(3, 1), 'discounts', '00000000-0000-0000-0000-0000000000a1', '{}', 'h', 'complete');
insert into digest_items (digest_id, user_id, ref_type, ref_id) values (pg_temp.uid(6, 1), '00000000-0000-0000-0000-0000000000a1', 'episode', pg_temp.uid(4, 2));
select is((select count(*)::int from public.notify_discount_candidates(pg_temp.uid(3, 1), '00000000-0000-0000-0000-0000000000a1', false)), 0, 'a user who already has the episode in a digest gets nothing');
select is((select count(*)::int from public.notify_public_discount_candidates(pg_temp.uid(3, 1))), 2, 'the public candidates do not depend on any user''s digest items');

-- retention covers the public digest and its device deliveries ------------------------------------------------------------------------------------
insert into scan_runs (id, scan_date_local, status, settings_snapshot) values (pg_temp.uid(3, 3), '2026-01-01', 'complete', '{}');
insert into digests (id, scan_run_id, kind, user_id, content, content_hash, cutoff_reason, created_at)
values (pg_temp.uid(6, 2), pg_temp.uid(3, 3), 'discounts', null, '{}', 'h', 'complete', now() - interval '200 days');
insert into digest_deliveries (digest_id, subscription_id, channel, idempotency_key) values (pg_temp.uid(6, 2), pg_temp.uid(9, 1), 'push', 'old');
select is((app.purge_notifications(100)->>'digests')::int, 1, 'one old public digest is purged');
select is((select count(*)::int from digest_deliveries where digest_id = pg_temp.uid(6, 2)), 0, 'its device deliveries go with it');

select * from finish();
rollback;
