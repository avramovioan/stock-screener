-- Notifications are Web Push only: the e-mail channel (Resend, unsubscribe links, delivery webhooks) is gone from the code.
-- Nothing that holds data is dropped (email_events, delivery history, the e-mail preference columns, the 'email' enum label):
-- they stay unused. This migration only removes what would otherwise still run or fail.

-- 1. No stored e-mail preference stays on, and no e-mail delivery stays waiting for a sender that no longer exists.
update notification_preferences set email_enabled = false where email_enabled;
update digest_deliveries set status = 'skipped', skip_reason = 'channel_removed'
 where channel = 'email' and status = 'pending';

-- 2. E-mail-only functions that no code calls any more (the Resend webhook, the unsubscribe link and the daily e-mail cap).
--    There is no e-mail-only cron job: the digest cut-off, retention and kick jobs serve push too and stay.
drop function if exists public.notify_consume_email_quota(uuid, bigint);
drop function if exists public.notify_record_email_event(text, text, text, text, jsonb, uuid);
drop function if exists public.notify_unsubscribe(uuid);
drop function if exists public.notify_recipient_candidates();
drop function if exists public.notify_defer_delivery(uuid, int, text, jsonb);
