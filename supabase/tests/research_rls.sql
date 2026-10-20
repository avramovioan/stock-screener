begin;
create extension if not exists pgtap with schema extensions;
select plan(16);
-- isolation: a seeded database already holds reports, sources, risk and broker rows (rolled back with the transaction)
truncate public.research_reports, public.research_sources, public.risk_monitor_state, public.risk_findings, public.broker_positions cascade;
set local session_replication_role = replica;

insert into public.research_reports (id, security_id, company_id, trigger, status, visibility, idempotency_key) values
  ('00000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'new_discount', 'complete', 'public',  'rls-a1'),
  ('00000000-0000-0000-0000-0000000000a2', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'monitor_first', 'complete', 'holders', 'rls-a2'),
  ('00000000-0000-0000-0000-0000000000a3', '10000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', 'monitor_first', 'complete', 'holders', 'rls-a3');
insert into public.research_sources (report_id, evidence_id, url, canonical_url, kind) values
  ('00000000-0000-0000-0000-0000000000a1', 1, 'https://x.example/1', 'https://x.example/1', 'other'),
  ('00000000-0000-0000-0000-0000000000a2', 1, 'https://x.example/2', 'https://x.example/2', 'other'),
  ('00000000-0000-0000-0000-0000000000a3', 1, 'https://x.example/3', 'https://x.example/3', 'other');
insert into public.risk_monitor_state (user_id, security_id, reasons) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', '{outside_top50}'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-000000000002', '{below_50b}');
insert into public.broker_positions (user_id, report_date, conid, symbol, currency, quantity, security_id, signal_security_id, match_status) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', '2026-10-14', 9001, 'S1', 'USD', 5, '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'matched_isin'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', '2026-10-14', 9002, 'S2', 'USD', 5, '10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 'matched_isin');
insert into public.risk_findings (user_id, security_id, fingerprint, category, severity, summary) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', 'fa', 'liquidity_debt', 'material', 'A finding'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-000000000002', 'fb', 'guidance', 'watch', 'B finding');
insert into public.ai_quota_usage (provider, resource, period_kind, period_start, used) values ('t', 'r', 'day', current_date, 1);

create temp table seen (label text primary key, n int not null);
grant all on seen to anon, authenticated;

-- anonymous visitor
set local role anon;
insert into seen select 'anon_reports', count(*) from public.research_reports;
insert into seen select 'anon_sources', count(*) from public.research_sources;
do $$ begin
  perform 1 from public.risk_monitor_state;
  insert into seen values ('anon_risk_state_denied', 0);
exception when insufficient_privilege then insert into seen values ('anon_risk_state_denied', 1); end $$;
do $$ begin
  update public.research_sources set title = 'x';
  insert into seen values ('anon_write_denied', 0);
exception when insufficient_privilege then insert into seen values ('anon_write_denied', 1); end $$;
reset role;

-- user A
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-00000000000a","role":"authenticated"}', true);
set local role authenticated;
insert into seen select 'a_reports', count(*) from public.research_reports;
insert into seen select 'a_sources', count(*) from public.research_sources;
insert into seen select 'a_reports_s2', count(*) from public.research_reports where id = '00000000-0000-0000-0000-0000000000a3';
insert into seen select 'a_state', count(*) from public.risk_monitor_state;
insert into seen select 'a_findings', count(*) from public.risk_findings;
do $$ begin
  insert into public.research_reports (security_id, company_id, trigger, idempotency_key)
    values ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'manual', 'rls-write');
  insert into seen values ('auth_write_denied', 0);
exception when insufficient_privilege then insert into seen values ('auth_write_denied', 1); end $$;
do $$ begin
  perform 1 from public.ai_quota_usage;
  insert into seen values ('auth_quota_denied', 0);
exception when insufficient_privilege then insert into seen values ('auth_quota_denied', 1); end $$;
reset role;

-- user B
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-0000-0000-00000000000b","role":"authenticated"}', true);
set local role authenticated;
insert into seen select 'b_reports', count(*) from public.research_reports;
insert into seen select 'b_reports_s1_holders', count(*) from public.research_reports where id = '00000000-0000-0000-0000-0000000000a2';
insert into seen select 'b_findings', count(*) from public.risk_findings;
reset role;

select is((select n from seen where label = 'anon_reports'), 1, 'anon sees only the public report');
select is((select n from seen where label = 'anon_sources'), 1, 'anon sees only sources of public reports');
select is((select n from seen where label = 'anon_risk_state_denied'), 1, 'anon cannot read risk_monitor_state');
select is((select n from seen where label = 'anon_write_denied'), 1, 'anon cannot write research_sources');
select is((select n from seen where label = 'a_reports'), 2, 'holder A sees the public report and the holders report of S1');
select is((select n from seen where label = 'a_sources'), 2, 'holder A sees the sources of those two reports');
select is((select n from seen where label = 'a_reports_s2'), 0, 'holder A does not see the holders report of S2');
select is((select n from seen where label = 'a_state'), 1, 'A sees only A''s monitor row');
select is((select n from seen where label = 'a_findings'), 1, 'A sees only A''s finding');
select is((select n from seen where label = 'auth_write_denied'), 1, 'authenticated users cannot insert reports');
select is((select n from seen where label = 'auth_quota_denied'), 1, 'authenticated users cannot read ai_quota_usage');
select is((select n from seen where label = 'b_reports'), 2, 'holder B sees the public report and the holders report of S2');
select is((select n from seen where label = 'b_reports_s1_holders'), 0, 'holder B does not see the holders report of S1');
select is((select n from seen where label = 'b_findings'), 1, 'B sees only B''s finding');
select is(app.holder('10000000-0000-0000-0000-000000000001'), false, 'app.holder is false without a JWT subject');
select is((select count(*)::int from public.v_card_research), (select count(*)::int from public.todays_discounts), 'the card research view exists and mirrors todays_discounts one row per card');

select * from finish();
rollback;
