begin;
create extension if not exists pgtap with schema extensions;
select plan(34);

-- helper: set the JWT claims that auth.uid() reads; the role is switched by the statement that follows
create function pg_temp.set_claims(p_uid text) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_uid = '' then '{"role":"authenticated"}'
         else json_build_object('sub', p_uid, 'role', 'authenticated')::text end, true);
  perform set_config('request.jwt.claim.sub', p_uid, true);
end $$;

-- three users; the trigger must create their profiles
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
values
  ('11111111-1111-4111-8111-111111111111', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'alice@example.test', '{"full_name":"Alice Example"}', '{"provider":"google","providers":["google"]}', now(), now()),
  ('22222222-2222-4222-8222-222222222222', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'bob@example.test', '{"display_name":"  Bob  "}', '{"provider":"email","providers":["email"]}', now(), now()),
  ('33333333-3333-4333-8333-333333333333', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'carol@example.test', '{}', '{"provider":"email","providers":["email"]}', now(), now());

-- 1-8: bootstrap trigger and columns (as the table owner)
select has_function('app', 'handle_new_user', 'app.handle_new_user() exists');
select trigger_is('auth', 'users', 'on_auth_user_created', 'app', 'handle_new_user', 'auth.users insert trigger is installed');
select has_column('public', 'profiles', 'display_name', 'profiles.display_name exists');
select has_column('public', 'profiles', 'updated_at', 'profiles.updated_at exists');
select is((select display_name from public.profiles where user_id = '11111111-1111-4111-8111-111111111111'),
  'Alice Example', 'display name falls back to full_name (Google users)');
select is((select display_name from public.profiles where user_id = '22222222-2222-4222-8222-222222222222'),
  'Bob', 'display_name metadata is trimmed');
select is((select display_name from public.profiles where user_id = '33333333-3333-4333-8333-333333333333'),
  null, 'no metadata gives a null display name');
select is((select count(*)::int from public.profiles where user_id in
  ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333')),
  3, 'one profile row per new user');

-- 9-17: user A against profiles and audit_events
select pg_temp.set_claims('11111111-1111-4111-8111-111111111111');
set local role authenticated;

select is((select count(*)::int from public.profiles), 1, 'A sees exactly one profile row');
select is((select count(*)::int from public.profiles where user_id = '22222222-2222-4222-8222-222222222222'),
  0, 'A cannot read B''s profile');
select lives_ok($$update public.profiles set display_name = 'Hacked'
  where user_id = '22222222-2222-4222-8222-222222222222'$$, 'A updating B''s row is a silent no-op (RLS filters it)');
select lives_ok($$update public.profiles set display_name = 'Alice Updated'
  where user_id = '11111111-1111-4111-8111-111111111111'$$, 'A can update her own display name');
select is((select display_name from public.profiles), 'Alice Updated', 'the update is visible to A');
select throws_ok($$update public.profiles set is_admin = true
  where user_id = '11111111-1111-4111-8111-111111111111'$$, '42501', null, 'A cannot make herself admin');
select throws_ok($$insert into public.profiles (user_id) values ('44444444-4444-4444-8444-444444444444')$$,
  '42501', null, 'clients cannot insert profiles');
select throws_ok($$delete from public.profiles where user_id = '11111111-1111-4111-8111-111111111111'$$,
  '42501', null, 'clients cannot delete profiles');
select throws_ok($$insert into public.audit_events (actor_id, action)
  values ('11111111-1111-4111-8111-111111111111', 'auth.forged')$$,
  '42501', null, 'clients cannot insert audit_events directly');

-- 18-26: the audit RPC for A
select lives_ok($$select public.record_audit('auth.password_changed',
  '{"via":"profile","new_password":"x","nested":{"Access_Token":"t"},"list":[{"secret":"s"}]}'::jsonb)$$,
  'record_audit succeeds for an authenticated caller');
select is((select count(*)::int from public.audit_events where action = 'auth.password_changed'),
  1, 'A reads her own audit row');
select is((select actor_id from public.audit_events where action = 'auth.password_changed'),
  '11111111-1111-4111-8111-111111111111'::uuid, 'the row belongs to the caller');
select is((select details ->> 'via' from public.audit_events where action = 'auth.password_changed'),
  'profile', 'harmless metadata is kept');
select is((select details ->> 'new_password' from public.audit_events where action = 'auth.password_changed'),
  '[redacted]', 'password keys are redacted');
select is((select details #>> '{nested,Access_Token}' from public.audit_events where action = 'auth.password_changed'),
  '[redacted]', 'nested token keys are redacted (case-insensitive)');
select is((select details #>> '{list,0,secret}' from public.audit_events where action = 'auth.password_changed'),
  '[redacted]', 'keys inside arrays are redacted');
select throws_ok($$select public.record_audit('broker.link', '{}'::jsonb)$$, '22023', null,
  'event types outside auth.* are rejected');
select throws_ok($$select public.record_audit('auth.x', '{}'::jsonb)$$, '22023', null,
  'malformed event types are rejected');

-- 27: B's profile is untouched (checked as the table owner)
reset role;
select is((select display_name from public.profiles where user_id = '22222222-2222-4222-8222-222222222222'),
  'Bob', 'A''s update attempt did not change B''s profile');

-- 28-31: user B is isolated from A's audit rows
select pg_temp.set_claims('22222222-2222-4222-8222-222222222222');
set local role authenticated;

select lives_ok($$select public.record_audit('auth.sign_out_all', '{"scope":"global"}'::jsonb)$$,
  'B can record an event');
select is((select count(*)::int from public.audit_events), 1, 'B sees only her own audit rows');
select is((select count(*)::int from public.audit_events where action = 'auth.password_changed'),
  0, 'B cannot see A''s audit rows');
select is((select count(*)::int from public.profiles where user_id = '11111111-1111-4111-8111-111111111111'),
  0, 'B cannot read A''s profile');

-- 32: a caller without a subject is refused
reset role;
select pg_temp.set_claims('');
set local role authenticated;
select throws_ok($$select public.record_audit('auth.password_changed', '{}'::jsonb)$$, '28000', null,
  'record_audit needs auth.uid()');

-- 33: anon cannot execute the RPC
reset role;
set local role anon;
select throws_ok($$select public.record_audit('auth.password_changed', '{}'::jsonb)$$, '42501', null,
  'anon cannot call record_audit');

-- 34: per-user hourly cap
reset role;
insert into public.audit_events (actor_id, action)
  select '33333333-3333-4333-8333-333333333333', 'auth.seed_event' from generate_series(1, 60);
select pg_temp.set_claims('33333333-3333-4333-8333-333333333333');
set local role authenticated;
select throws_ok($$select public.record_audit('auth.password_changed', '{}'::jsonb)$$, '54000', null,
  'record_audit is capped at 60 events per hour');

reset role;
select * from finish();
rollback;
