begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

-- FK parents are not needed for this test (the function only reads refs by id).
set local session_replication_role = replica;

insert into auth.users (id, email, email_confirmed_at, instance_id, aud, role)
values ('00000000-0000-0000-0000-0000000000a1', 'a@example.test', now(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');
insert into scan_runs (id, scan_date_local, status, settings_snapshot) values
  ('00000000-0000-0000-0000-0000000000c1', '2026-01-01', 'complete', '{}'),
  ('00000000-0000-0000-0000-0000000000c2', '2026-01-02', 'complete', '{}');

insert into digests (id, scan_run_id, kind, user_id, content, content_hash, cutoff_reason, created_at) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', 'discounts', '00000000-0000-0000-0000-0000000000a1', '{}', 'h', 'complete', now() - interval '200 days'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000c1', 'portfolio', '00000000-0000-0000-0000-0000000000a1', '{}', 'h', 'complete', now() - interval '200 days'),
  ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-0000000000c2', 'discounts', '00000000-0000-0000-0000-0000000000a1', '{}', 'h', 'complete', now() - interval '10 days'),
  ('00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-0000000000c2', 'portfolio', '00000000-0000-0000-0000-0000000000a1', '{}', 'h', 'complete', now() - interval '200 days');
insert into digest_items (digest_id, user_id, ref_type, ref_id) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'episode', '00000000-0000-0000-0000-0000000000f1'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000a1', 'episode', '00000000-0000-0000-0000-0000000000f2'),
  ('00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-0000000000a1', 'finding', '00000000-0000-0000-0000-0000000000f3');
insert into digest_deliveries (digest_id, user_id, channel, idempotency_key) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'push', 'k1');
-- f2 is a still-active episode: its (old) digest must be kept so dedupe never breaks
insert into signal_episodes (id, security_id, company_id, kind, mode, threshold_line, status, opened_scan_run_id, opened_session_date,
  opened_close, opened_line_value, open_reason, last_evaluated_session_date)
values ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000a9', '00000000-0000-0000-0000-0000000000a8', 'premium1', 'worldwide', '+1',
  'active', '00000000-0000-0000-0000-0000000000c1', '2026-01-01', 1, 1, 'new_entry', '2026-01-01');
-- f3 is a still-open risk finding: same rule
insert into risk_findings (id, user_id, security_id, fingerprint, category, severity, summary)
values ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a9', 'fp', 'liquidity_debt', 'material', 's');

insert into email_events (svix_id, type, received_at) values ('old', 'email.sent', now() - interval '200 days'), ('new', 'email.sent', now());
insert into push_subscriptions (user_id, endpoint, p256dh, auth, revoked_at, revoke_reason) values
  ('00000000-0000-0000-0000-0000000000a1', 'https://p.example.test/old', 'k', 's', now() - interval '40 days', 'gone'),
  ('00000000-0000-0000-0000-0000000000a1', 'https://p.example.test/recent', 'k', 's', now() - interval '5 days', 'gone'),
  ('00000000-0000-0000-0000-0000000000a1', 'https://p.example.test/live', 'k', 's', null, null);

set local session_replication_role = default; -- restore FK actions so the cascades below run

select is((app.purge_notifications(100)->>'digests')::int, 1, 'one old digest without live references is purged');
select is((select count(*)::int from digests where id = '00000000-0000-0000-0000-0000000000e1'), 0, 'the old unreferenced digest is gone');
select is((select count(*)::int from digest_deliveries where digest_id = '00000000-0000-0000-0000-0000000000e1'), 0, 'its deliveries are gone (cascade)');
select is((select count(*)::int from digests where id in ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000e3')), 2,
  'an old digest with an active episode and a recent digest are kept');
select is((select count(*)::int from digests where id = '00000000-0000-0000-0000-0000000000e4'), 1, 'an old digest with an open risk finding is kept');
select is((select count(*)::int from email_events), 1, 'old email events are purged');
select is((select count(*)::int from push_subscriptions where endpoint like '%/old'), 0, 'subscriptions revoked more than 30 days ago are purged');
select is((select count(*)::int from push_subscriptions where endpoint not like '%/old'), 2, 'recent revoked and live subscriptions are kept');
select is((select count(*)::int from cron.job where jobname = 'retention-notifications'), 1, 'the retention cron job is scheduled');

select * from finish();
rollback;
