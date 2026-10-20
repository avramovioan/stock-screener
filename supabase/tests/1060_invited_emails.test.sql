-- Migration 20261015009600: the invite list (public.invited_emails) and the service-only lookup used by account-access. 14 assertions.
begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

select has_table('public', 'invited_emails', 'the invite table exists');
select is((select relrowsecurity from pg_class where oid = 'public.invited_emails'::regclass), true, 'RLS is on');
select is((select count(*)::int from pg_policies where tablename = 'invited_emails'), 0, 'no policies');
select is(has_table_privilege('anon', 'public.invited_emails', 'select'), false, 'anon has no access');
select is(has_table_privilege('authenticated', 'public.invited_emails', 'select'), false, 'authenticated has no access');
select col_default_is('public', 'invited_emails', 'reset_password', 'false', 'reset_password defaults to false');

insert into public.invited_emails (email, note) values ('  Friend@Example.COM ', 'a friend');
select is((select email from public.invited_emails), 'friend@example.com', 'e-mails are trimmed and lower-cased on insert');
update public.invited_emails set email = ' Other@Example.com ';
select is((select email from public.invited_emails), 'other@example.com', 'and on update');
select throws_ok($$insert into public.invited_emails (email) values ('OTHER@example.com')$$, '23505', null, 'a different case is the same invite');

insert into auth.users (id, email, email_confirmed_at, instance_id, aud, role) values
  ('00000000-0000-0000-0000-0000000000c1', 'Other@Example.com', now(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');
select is((select user_id from public.account_access_lookup('  OTHER@example.com ')), '00000000-0000-0000-0000-0000000000c1'::uuid, 'lookup finds the auth user case-insensitively');
select is((select invited from public.account_access_lookup('other@example.com')), true, 'lookup reports the invite');
select is((select invited from public.account_access_lookup('nobody@example.com')), false, 'an unknown e-mail is not invited');
select is(has_function_privilege('anon', 'public.account_access_lookup(text)', 'execute'), false, 'anon cannot run the lookup');
select is(has_function_privilege('service_role', 'public.account_access_lookup(text)', 'execute'), true, 'service_role can');

select * from finish();
rollback;
