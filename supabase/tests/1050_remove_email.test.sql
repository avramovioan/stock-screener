begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

-- the e-mail-only functions are gone --------------------------------------------------------------------
select hasnt_function('public', 'notify_consume_email_quota', 'the daily e-mail cap function is gone');
select hasnt_function('public', 'notify_record_email_event', 'the Resend webhook recorder is gone');
select hasnt_function('public', 'notify_unsubscribe', 'the unsubscribe function is gone');
select hasnt_function('public', 'notify_recipient_candidates', 'the webhook recipient lookup is gone');
select hasnt_function('public', 'notify_defer_delivery', 'the capped-delivery deferral is gone');

-- the push path keeps every function it uses --------------------------------------------------------------
select has_function('public', 'notify_digest_users', 'digest users');
select has_function('public', 'notify_claim_deliveries', 'claiming deliveries');
select has_function('public', 'notify_complete_delivery', 'completing deliveries');
select has_function('public', 'notify_active_subscriptions', 'push subscriptions');
select has_function('public', 'notify_mark_subscription', 'marking a subscription');
select has_function('app', 'consume_quota_capped', array['text', 'text', 'bigint', 'text', 'bigint'], 'the generic quota function stays');

-- data is kept, cron is untouched -------------------------------------------------------------------------
select has_table('public', 'email_events', 'e-mail event history is kept');
select has_column('public', 'notification_preferences', 'email_enabled', 'the e-mail preference column is kept');
select is((select count(*)::int from cron.job where jobname in ('digest-cutoff-1000', 'digest-cutoff-1100', 'retention-notifications')), 3, 'the push digest and retention cron jobs stay');

select * from finish();
rollback;
