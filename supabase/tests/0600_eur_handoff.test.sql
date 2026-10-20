begin;
create extension if not exists pgtap with schema extensions;
select plan(59);

-- helper: set the JWT claims that auth.uid() reads (same helper as 0300_auth_profiles.test.sql)
create function pg_temp.set_claims(p_uid text) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_uid = '' then '{"role":"authenticated"}'
         else json_build_object('sub', p_uid, 'role', 'authenticated')::text end, true);
  perform set_config('request.jwt.claim.sub', p_uid, true);
end $$;

-- fixtures (as the table owner) ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
values
  ('61111111-1111-4111-8111-111111111111', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'p6a@example.test', '{}', '{"provider":"email","providers":["email"]}', now(), now()),
  ('62222222-2222-4222-8222-222222222222', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'p6b@example.test', '{}', '{"provider":"email","providers":["email"]}', now(), now());

-- isolation: an integration run leaves real rows behind. Remove them inside this transaction
-- (rolled back at the end); replica role skips the FK cascades, which this test does not read.
set local session_replication_role = replica;
delete from public.securities; -- the assertions below count due and shown securities, so start from an empty universe
delete from public.broker_positions; -- held securities are resolution targets too
delete from public.eur_equivalent_overrides;
delete from public.eur_equivalents;
delete from public.ibkr_catalogue;
set local session_replication_role = default;

insert into public.companies (id, name, name_normalized) values
  ('c1000000-0000-4000-8000-000000000001', 'Microsoft Corporation', 'microsoft'),
  ('c1000000-0000-4000-8000-000000000002', 'ASML Holding N.V.', 'asml holding'),
  ('c1000000-0000-4000-8000-000000000003', 'Nothing Inc.', 'nothing'),
  ('c1000000-0000-4000-8000-000000000004', 'Newcomer Inc.', 'newcomer'),
  ('c1000000-0000-4000-8000-000000000005', 'Watched Inc.', 'watched');
insert into public.securities (id, company_id, yahoo_symbol, exchange_code, currency, currency_major, quote_type, role, is_canonical) values
  ('d1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'MSFT', 'NMS', 'USD', 'USD', 'EQUITY', 'canonical', true),
  ('d1000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000002', 'ASML', 'NMS', 'USD', 'USD', 'EQUITY', 'canonical', true),
  ('d1000000-0000-4000-8000-000000000003', 'c1000000-0000-4000-8000-000000000003', 'NOTH', 'NMS', 'USD', 'USD', 'EQUITY', 'canonical', true),
  ('d1000000-0000-4000-8000-000000000004', 'c1000000-0000-4000-8000-000000000004', 'NEW1', 'NMS', 'USD', 'USD', 'EQUITY', 'canonical', true),
  ('d1000000-0000-4000-8000-000000000005', 'c1000000-0000-4000-8000-000000000005', 'WATCH', 'NMS', 'USD', 'USD', 'EQUITY', 'canonical', true);
insert into public.ibkr_catalogue (exchange_id, conid, symbol, local_symbol, isin, currency, description, product_type)
values ('IBIS', 12178239, 'MSF', 'MSF', 'US5949181045', 'EUR', 'MICROSOFT CORP', 'STK');

-- 1-8 structure ----------------------------------------------------------------------------------------------
select has_table('public', 'ibkr_catalogue', 'ibkr_catalogue exists');
select has_table('public', 'eur_equivalents', 'eur_equivalents exists');
select has_table('public', 'eur_equivalent_overrides', 'eur_equivalent_overrides exists');
select col_is_pk('public', 'ibkr_catalogue', array['exchange_id', 'conid'], 'ibkr_catalogue primary key is (exchange_id, conid)');
select has_index('public', 'ibkr_catalogue', 'ibkr_catalogue_isin_idx', 'ibkr_catalogue is indexed by isin');
select has_index('public', 'ibkr_catalogue', 'ibkr_catalogue_local_symbol_idx', 'ibkr_catalogue is indexed by local_symbol');
select enum_has_labels('public', 'eur_status', array['verified', 'unverified', 'none'], 'eur_status labels');
select has_column('public', 'profiles', 'default_destination', 'profiles.default_destination exists');

-- 9-18 eur_equivalents constraints (A-28 in the database) -----------------------------------------------------
select lives_ok($$insert into public.eur_equivalents (security_id, ibkr_exchange_id, ibkr_conid, ibkr_local_symbol, isin, eur_symbol_yahoo, status, verified_at)
  values ('d1000000-0000-4000-8000-000000000001', 'IBIS', 12178239, 'MSF', 'US5949181045', 'MSF.DE', 'verified', now())$$, 'a complete verified row is accepted');
select throws_ok($$insert into public.eur_equivalents (security_id, ibkr_exchange_id, ibkr_conid, ibkr_local_symbol, status, verified_at)
  values ('d1000000-0000-4000-8000-000000000001', 'IBIS', 1, 'X', 'unverified', null)$$, '23505', null, 'one row per security and exchange');
select throws_ok($$insert into public.eur_equivalents (security_id, ibkr_exchange_id, ibkr_conid, ibkr_local_symbol, status, verified_at)
  values ('d1000000-0000-4000-8000-000000000002', 'IBIS', 1, 'X', 'verified', now())$$, '23514', null, 'verified needs the Yahoo symbol');
select throws_ok($$insert into public.eur_equivalents (security_id, ibkr_exchange_id, ibkr_conid, ibkr_local_symbol, eur_symbol_yahoo, status, verified_at)
  values ('d1000000-0000-4000-8000-000000000002', 'IBIS', 1, 'X', 'X.DE', 'verified', null)$$, '23514', null, 'verified needs verified_at');
select throws_ok($$insert into public.eur_equivalents (security_id, ibkr_exchange_id, ibkr_conid, ibkr_local_symbol, status, verified_at)
  values ('d1000000-0000-4000-8000-000000000002', 'IBIS', 1, 'X', 'unverified', now())$$, '23514', null, 'unverified never carries verified_at');
select throws_ok($$insert into public.eur_equivalents (security_id, ibkr_exchange_id, ibkr_conid, status)
  values ('d1000000-0000-4000-8000-000000000003', 'IBIS', 1, 'none')$$, '23514', null, 'none carries no contract');
select throws_ok($$insert into public.eur_equivalents (security_id, ibkr_exchange_id, ibkr_conid, ibkr_local_symbol, status)
  values ('d1000000-0000-4000-8000-000000000002', 'FWB', 1, 'X', 'unverified')$$, '23514', null, 'only IBIS and AEB are accepted');
select lives_ok($$insert into public.eur_equivalents (security_id, ibkr_exchange_id, ibkr_conid, ibkr_local_symbol, isin, status)
  values ('d1000000-0000-4000-8000-000000000001', 'AEB', 5, 'MSF', 'US5949181045', 'unverified')$$, 'an unverified row is accepted without a Yahoo symbol');
select lives_ok($$insert into public.eur_equivalents (security_id, ibkr_exchange_id, status)
  values ('d1000000-0000-4000-8000-000000000003', 'IBIS', 'none')$$, 'a none row is accepted');
select throws_ok($$insert into public.eur_equivalents (security_id, ibkr_exchange_id, ibkr_conid, ibkr_local_symbol, currency, status)
  values ('d1000000-0000-4000-8000-000000000002', 'AEB', 1, 'X', 'USD', 'unverified')$$, '23514', null, 'the currency is EUR');

-- 19-25 app.replace_eur_equivalents --------------------------------------------------------------------------
select is(app.replace_eur_equivalents('d1000000-0000-4000-8000-000000000002', $j$[
  {"ibkr_exchange_id":"IBIS","ibkr_conid":777,"ibkr_local_symbol":"ASME","isin":"NL0010273215","eur_symbol_yahoo":null,"status":"unverified","verification":{"failed":["isin_confirmed"]},"verified_at":null},
  {"ibkr_exchange_id":"AEB","ibkr_conid":117589399,"ibkr_local_symbol":"ASML","isin":"NL0010273215","eur_symbol_yahoo":"ASML.AS","status":"verified","verification":{"failed":[]},"verified_at":"2026-10-15T07:30:00Z"}
]$j$::jsonb), 2, 'two rows are written');
select is((select count(*)::int from public.eur_equivalents where security_id = 'd1000000-0000-4000-8000-000000000002'), 2, 'ASML has an IBIS and an AEB row');
select is(app.replace_eur_equivalents('d1000000-0000-4000-8000-000000000002', $j$[
  {"ibkr_exchange_id":"AEB","ibkr_conid":117589399,"ibkr_local_symbol":"ASML","isin":"NL0010273215","eur_symbol_yahoo":"ASML.AS","status":"verified","verification":{"failed":[]},"verified_at":"2026-10-16T07:30:00Z"}
]$j$::jsonb), 1, 'a second call upserts');
select is((select array_agg(ibkr_exchange_id order by ibkr_exchange_id) from public.eur_equivalents where security_id = 'd1000000-0000-4000-8000-000000000002'),
  array['AEB'], 'the IBIS row that is no longer in the set is deleted');
select throws_ok($$select app.replace_eur_equivalents('d1000000-0000-4000-8000-000000000002', '[]'::jsonb)$$, '22023', null, 'an empty array never wipes a security');
select throws_ok($$select app.replace_eur_equivalents('d1000000-0000-4000-8000-000000000002', '{}'::jsonb)$$, '22023', null, 'a non-array is refused');
select throws_ok($$select app.replace_eur_equivalents('d1000000-0000-4000-8000-000000000002',
  '[{"ibkr_exchange_id":"IBIS","ibkr_conid":1,"ibkr_local_symbol":"X","status":"maybe"}]'::jsonb)$$, '22P02', null, 'an unknown status is refused');

-- 26-33 anon ----------------------------------------------------------------------------------------------------
set local role anon;
select ok((select count(*) from public.eur_equivalents) >= 2, 'anon reads eur_equivalents');
select ok((select count(*) from public.ibkr_catalogue) >= 1, 'anon reads ibkr_catalogue');
select throws_ok($$insert into public.eur_equivalents (security_id, ibkr_exchange_id, status) values ('d1000000-0000-4000-8000-000000000004', 'IBIS', 'none')$$,
  '42501', null, 'anon cannot insert eur_equivalents');
select throws_ok($$update public.eur_equivalents set status = 'none'$$, '42501', null, 'anon cannot update eur_equivalents');
select throws_ok($$insert into public.ibkr_catalogue (exchange_id, conid, symbol, local_symbol, currency, product_type) values ('IBIS', 1, 'X', 'X', 'EUR', 'STK')$$,
  '42501', null, 'anon cannot insert ibkr_catalogue');
select throws_ok($$select * from public.eur_equivalent_overrides$$, '42501', null, 'anon cannot read the overrides');
select throws_ok($$select app.replace_eur_equivalents('d1000000-0000-4000-8000-000000000002', '[]'::jsonb)$$, '42501', null, 'anon cannot call replace_eur_equivalents');
select throws_ok($$select * from app.eur_resolve_targets('00000000-0000-0000-0000-000000000000', 1)$$, '42501', null, 'anon cannot call eur_resolve_targets');
reset role;

-- 34-43 authenticated users (profiles.default_destination, A-39) -----------------------------------------------
select pg_temp.set_claims('61111111-1111-4111-8111-111111111111');
set local role authenticated;
select ok((select count(*) from public.eur_equivalents) >= 2, 'authenticated reads eur_equivalents');
select throws_ok($$delete from public.eur_equivalents$$, '42501', null, 'authenticated cannot delete eur_equivalents');
select throws_ok($$select * from public.eur_equivalent_overrides$$, '42501', null, 'authenticated cannot read the overrides');
select throws_ok($$select app.replace_eur_equivalents('d1000000-0000-4000-8000-000000000002', '[]'::jsonb)$$, '42501', null, 'authenticated cannot call replace_eur_equivalents');
select is((select default_destination from public.profiles where user_id = '61111111-1111-4111-8111-111111111111'), 'IBIS2', 'the default destination starts as IBIS2');
select lives_ok($$update public.profiles set default_destination = 'AEB' where user_id = '61111111-1111-4111-8111-111111111111'$$, 'the owner changes their destination');
select is((select default_destination from public.profiles where user_id = '61111111-1111-4111-8111-111111111111'), 'AEB', 'the change is stored');
select throws_ok($$update public.profiles set default_destination = 'XETRA' where user_id = '61111111-1111-4111-8111-111111111111'$$, '23514', null, 'only IBIS2, IBIS and AEB are accepted');
select lives_ok($$update public.profiles set default_destination = 'IBIS' where user_id = '62222222-2222-4222-8222-222222222222'$$, 'updating another user''s profile is a silent no-op');
reset role;
select is((select default_destination from public.profiles where user_id = '62222222-2222-4222-8222-222222222222'), 'IBIS2', 'another user''s destination is unchanged');

-- 44-50 overrides (service role = the table owner here) ---------------------------------------------------------
select throws_ok($$insert into public.eur_equivalent_overrides (security_id, ibkr_exchange_id, action, reason)
  values ('d1000000-0000-4000-8000-000000000003', 'IBIS', 'block', 'short')$$, '23514', null, 'a reason of at least 10 characters is required');
select throws_ok($$insert into public.eur_equivalent_overrides (security_id, ibkr_exchange_id, action, reason)
  values ('d1000000-0000-4000-8000-000000000003', 'IBIS', 'force', 'checked on the IBKR ticket')$$, '23514', null, 'force needs conid, local symbol and Yahoo symbol');
select lives_ok($$insert into public.eur_equivalent_overrides (security_id, ibkr_exchange_id, action, ibkr_conid, ibkr_local_symbol, eur_symbol_yahoo, reason)
  values ('d1000000-0000-4000-8000-000000000003', 'IBIS', 'force', 99, 'NOTH', 'NOTH.DE', 'checked on the IBKR ticket')$$, 'a force override is accepted');
select throws_ok($$insert into public.eur_equivalent_overrides (security_id, ibkr_exchange_id, action, reason)
  values ('d1000000-0000-4000-8000-000000000003', 'IBIS', 'block', 'second active override')$$, '23505', null, 'one active override per security and exchange');
select is((select count(*)::int from public.audit_events where target_type = 'security' and target_id = 'd1000000-0000-4000-8000-000000000003'), 1, 'the insert is audited');
select lives_ok($$update public.eur_equivalent_overrides set active = false where security_id = 'd1000000-0000-4000-8000-000000000003'$$, 'an override can be deactivated');
select is((select count(*)::int from public.audit_events where target_type = 'security' and target_id = 'd1000000-0000-4000-8000-000000000003'), 2, 'the update is audited');

-- 51-55 eur_resolve_targets ------------------------------------------------------------------------------------
set local session_replication_role = replica; -- a leftover run for the same local date (integration run) would hit the unique key
delete from public.scan_runs where scan_date_local = '2026-10-15';
set local session_replication_role = default;
insert into public.scan_runs (id, scan_date_local, settings_snapshot, results_published_at)
values ('e1000000-0000-4000-8000-000000000001', '2026-10-15', '{}'::jsonb, now());
insert into public.signal_episodes (id, security_id, company_id, kind, mode, threshold_line, opened_scan_run_id, opened_session_date, opened_close, opened_line_value, open_reason, last_evaluated_session_date)
select ('f1000000-0000-4000-8000-00000000000' || n)::uuid, ('d1000000-0000-4000-8000-00000000000' || n)::uuid, ('c1000000-0000-4000-8000-00000000000' || n)::uuid,
       'discount', 'worldwide', '-3', 'e1000000-0000-4000-8000-000000000001', '2026-10-14', 100, 110, 'new_entry', '2026-10-14'
  from generate_series(1, 4) as n;
insert into public.todays_discounts (scan_run_id, mode, security_id, company_id, episode_id, is_new_episode, rank, close, currency, session_date, threshold_line,
                                     lower_line_end, channel, trend_ok, eligibility, operational_category, category_reason, data_freshness, display_order)
select 'e1000000-0000-4000-8000-000000000001', 'worldwide', ('d1000000-0000-4000-8000-00000000000' || n)::uuid, ('c1000000-0000-4000-8000-00000000000' || n)::uuid,
       ('f1000000-0000-4000-8000-00000000000' || n)::uuid, true, n, 100, 'USD', '2026-10-14', '-3', 110, '{}'::jsonb, true, '{}'::jsonb, 'pending', 'research_pending', 'fresh', n
  from generate_series(1, 4) as n;

-- fresh rows: only the security without any row (NEW1) is due
select is((select array_agg(t order by t) from app.eur_resolve_targets('e1000000-0000-4000-8000-000000000001', 40) t),
  array['d1000000-0000-4000-8000-000000000004']::uuid[], 'only the never-resolved security is due');

-- age the rows by hand (the touch trigger would reset updated_at)
alter table public.eur_equivalents disable trigger eur_equivalents_touch;
alter table public.eur_equivalent_overrides disable trigger eur_overrides_touch;
update public.eur_equivalents set updated_at = now() - interval '31 days' where security_id = 'd1000000-0000-4000-8000-000000000001' and ibkr_exchange_id = 'IBIS';
update public.eur_equivalents set updated_at = now() - interval '1 day' where security_id = 'd1000000-0000-4000-8000-000000000001' and ibkr_exchange_id = 'AEB';
update public.eur_equivalent_overrides set updated_at = now() + interval '1 hour' where security_id = 'd1000000-0000-4000-8000-000000000003';
select is((select array_agg(t order by t) from app.eur_resolve_targets('e1000000-0000-4000-8000-000000000001', 40) t),
  array['d1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000003', 'd1000000-0000-4000-8000-000000000004']::uuid[],
  'an expired row (31 days), a changed override and a never-resolved security are due; a fresh verified row is not');
select is((select count(*)::int from app.eur_resolve_targets('e1000000-0000-4000-8000-000000000001', 1)), 1, 'the limit is honoured');
-- the operator watch list adds canonical securities that are not cards (and a malformed value never breaks the function)
update public.app_settings set value = jsonb_set(value, '{extra_symbols}', '["WATCH", "NMSX"]'::jsonb) where key = 'eur_catalogue';
select is((select array_agg(t order by t) from app.eur_resolve_targets('e1000000-0000-4000-8000-000000000001', 40) t),
  array['d1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000003', 'd1000000-0000-4000-8000-000000000004', 'd1000000-0000-4000-8000-000000000005']::uuid[],
  'a watch-list symbol is resolved even though it is not a card; unknown symbols are ignored');
update public.app_settings set value = jsonb_set(value, '{extra_symbols}', '"WATCH"'::jsonb) where key = 'eur_catalogue';
select lives_ok($$select count(*) from app.eur_resolve_targets('e1000000-0000-4000-8000-000000000001', 40)$$, 'a malformed watch list is ignored, not an error');
alter table public.eur_equivalents enable trigger eur_equivalents_touch;
alter table public.eur_equivalent_overrides enable trigger eur_overrides_touch;

-- 56-59 the public cards view and feed ---------------------------------------------------------------------------
-- MSFT: verified IBIS + unverified AEB; ASML: verified AEB only; NOTH: none row; NEW1: no row
select app.replace_eur_equivalents('d1000000-0000-4000-8000-000000000003', '[{"ibkr_exchange_id":"IBIS","status":"none","verification":{"reason":"no_catalogue_candidate"}}]'::jsonb);
set local role anon;
select is((select eur_status || ':' || ibkr_exchange_id || ':' || eur_symbol_yahoo from public.v_todays_discounts where yahoo_symbol = 'MSFT'),
  'verified:IBIS:MSF.DE', 'the card shows the verified IBIS line before the unverified AEB line');
select is((select eur_status || ':' || ibkr_exchange_id from public.v_todays_discounts where yahoo_symbol = 'ASML'), 'verified:AEB', 'a verified AEB line is shown when it is the only verified one');
select is((select eur_status || ':' || coalesce(eur_symbol_yahoo, '-') from public.v_todays_discounts where yahoo_symbol = 'NOTH'), 'none:-', 'a none row shows no EUR symbol');
select is((select count(*)::int from public.todays_discounts_feed('worldwide') where eur_status is null), 1, 'a security without any row has a null EUR status (the UI says "No verified EUR equivalent")');
reset role;

select * from finish();
rollback;
