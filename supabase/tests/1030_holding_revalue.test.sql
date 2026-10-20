begin;
create extension if not exists pgtap with schema extensions;
select plan(11);

-- isolation: a seeded database (e2e setup) may already hold broker rows (rolled back with the transaction)
truncate public.broker_connections, public.broker_positions, public.broker_sync_runs cascade;

insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values
  ('a0000000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a@example.test', now(), now()),
  ('b0000000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b@example.test', now(), now());

-- a screened security (company + listing) for the signal link
insert into public.companies (id, name, name_normalized) values ('c0000000-0000-4000-8000-0000000000c1', 'Revalue Co', 'revalue co');
insert into public.securities (id, company_id, yahoo_symbol, exchange_code, currency, currency_major, quote_type)
values ('50000000-0000-4000-8000-0000000000e1', 'c0000000-0000-4000-8000-0000000000c1', 'RVC', 'NMS', 'USD', 'USD', 'EQUITY');

-- user A holds conid 1 (screened) and conid 2 (no signal security); user B holds conid 3
insert into public.broker_positions (user_id, report_date, conid, symbol, currency, quantity, signal_security_id) values
  ('a0000000-0000-4000-8000-00000000000a', '2026-10-14', 1, 'RVC', 'USD', 10, '50000000-0000-4000-8000-0000000000e1'),
  ('a0000000-0000-4000-8000-00000000000a', '2026-10-14', 2, 'XYZ', 'USD', 5, null),
  ('b0000000-0000-4000-8000-00000000000b', '2026-10-14', 3, 'RVC', 'USD', 7, '50000000-0000-4000-8000-0000000000e1');

select has_column('public', 'broker_positions', 'valuation_revalued_at', 'the re-evaluation stamp column exists');
select is(has_function_privilege('service_role', 'app.claim_holding_revalue(uuid, bigint)', 'execute'), true, 'service_role may claim');
select is(has_function_privilege('authenticated', 'app.claim_holding_revalue(uuid, bigint)', 'execute'), false, 'authenticated may not claim');
select is(has_function_privilege('anon', 'app.claim_holding_revalue(uuid, bigint)', 'execute'), false, 'anon may not claim');

select is((select outcome from app.claim_holding_revalue('a0000000-0000-4000-8000-00000000000a', 1)), 'claimed',
  'first claim of a screened holding succeeds');
select is((select valuation_revalued_at is not null from public.broker_positions where user_id = 'a0000000-0000-4000-8000-00000000000a' and conid = 1),
  true, 'the claim stamps valuation_revalued_at');
select results_eq(
  $$ select outcome, signal_security_id, next_allowed_at > now() + interval '23 hours' from app.claim_holding_revalue('a0000000-0000-4000-8000-00000000000a', 1) $$,
  $$ values ('cooldown'::text, '50000000-0000-4000-8000-0000000000e1'::uuid, true) $$,
  'a second claim within 24 h is refused and reports the next allowed time');
select is((select outcome from app.claim_holding_revalue('a0000000-0000-4000-8000-00000000000a', 2)), 'not_screened',
  'a holding without a signal security is not screened (and is not stamped)');
select is((select valuation_revalued_at is null from public.broker_positions where user_id = 'a0000000-0000-4000-8000-00000000000a' and conid = 2),
  true, 'not_screened leaves the stamp empty');
select is((select outcome from app.claim_holding_revalue('a0000000-0000-4000-8000-00000000000a', 3)), 'not_found',
  'another user''s conid is not found');

update public.broker_positions set valuation_revalued_at = now() - interval '25 hours'
 where user_id = 'a0000000-0000-4000-8000-00000000000a' and conid = 1;
select is((select outcome from app.claim_holding_revalue('a0000000-0000-4000-8000-00000000000a', 1)), 'claimed',
  'after 24 h the holding can be re-evaluated again');

select * from finish();
rollback;
