begin;
create extension if not exists pgtap with schema extensions;
begin;
select plan(13);
set local session_replication_role = replica;   -- fixture rows skip FKs to securities/companies/scan_runs

insert into public.research_reports (id, security_id, company_id, trigger, status, idempotency_key, is_current)
values ('00000000-0000-0000-0000-0000000000b1', '10000000-0000-0000-0000-000000000001',
        '20000000-0000-0000-0000-000000000001', 'new_discount', 'complete',
        '10000000-0000-0000-0000-000000000001:new_discount:2026-10-15', true);

select throws_ok(
  $$insert into public.research_reports (security_id, company_id, trigger, idempotency_key, is_current)
    values ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'refresh', 'k-second-current', true)$$,
  '23505', null, 'research_one_current: a second current report for one security is rejected');

select lives_ok(
  $$insert into public.research_reports (id, security_id, company_id, trigger, status, idempotency_key)
    values ('00000000-0000-0000-0000-0000000000b2', '10000000-0000-0000-0000-000000000001',
            '20000000-0000-0000-0000-000000000001', 'refresh', 'complete', 'k-refresh')$$,
  'a non-current report for the same security is allowed');

select throws_ok(
  $$insert into public.research_reports (security_id, company_id, trigger, idempotency_key)
    values ('10000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', 'refresh', 'k-refresh')$$,
  '23505', null, 'idempotency_key is unique');

select is(app.promote_research_report('00000000-0000-0000-0000-0000000000b2'),
          '00000000-0000-0000-0000-0000000000b1'::uuid, 'promote returns the superseded report id');
select is((select is_current from public.research_reports where id = '00000000-0000-0000-0000-0000000000b1'),
          false, 'the previous report is no longer current');
select is((select is_current from public.research_reports where id = '00000000-0000-0000-0000-0000000000b2'),
          true, 'the promoted report is current');
select is((select supersedes_id from public.research_reports where id = '00000000-0000-0000-0000-0000000000b2'),
          '00000000-0000-0000-0000-0000000000b1'::uuid, 'supersedes_id points at the previous report');

insert into public.research_reports (id, security_id, company_id, trigger, status, idempotency_key)
values ('00000000-0000-0000-0000-0000000000b3', '10000000-0000-0000-0000-000000000001',
        '20000000-0000-0000-0000-000000000001', 'manual', 'running', 'k-running');
select throws_ok($$select app.promote_research_report('00000000-0000-0000-0000-0000000000b3')$$,
                 'P0001', null, 'only a complete report can become current');

insert into public.research_sources (report_id, evidence_id, url, canonical_url, kind)
values ('00000000-0000-0000-0000-0000000000b2', 1, 'https://a.example/x', 'https://a.example/x', 'other');
select throws_ok(
  $$insert into public.research_sources (report_id, evidence_id, url, canonical_url, kind)
    values ('00000000-0000-0000-0000-0000000000b2', 1, 'https://a.example/y', 'https://a.example/y', 'other')$$,
  '23505', null, 'evidence_id is unique per report');
select throws_ok(
  $$insert into public.research_sources (report_id, evidence_id, url, canonical_url, kind)
    values ('00000000-0000-0000-0000-0000000000b2', 2, 'https://a.example/x?utm_source=z', 'https://a.example/x', 'other')$$,
  '23505', null, 'canonical_url is unique per report (ledger dedupe)');
select throws_ok(
  $$insert into public.research_sources (report_id, evidence_id, url, canonical_url, kind, excerpt)
    values ('00000000-0000-0000-0000-0000000000b2', 3, 'https://a.example/z', 'https://a.example/z', 'other', repeat('x', 2001))$$,
  '23514', null, 'excerpt is capped at 2,000 characters');

insert into public.risk_findings (user_id, security_id, fingerprint, category, severity, summary)
values ('aaaaaaaa-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', 'fp1', 'liquidity_debt', 'material', 's');
select throws_ok(
  $$insert into public.risk_findings (user_id, security_id, fingerprint, category, severity, summary)
    values ('aaaaaaaa-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', 'fp1', 'liquidity_debt', 'material', 's2')$$,
  '23505', null, 'a finding fingerprint is unique per user and security');

select throws_ok(
  $$insert into public.research_reports (security_id, company_id, trigger, idempotency_key, conclusion)
    values ('10000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000003', 'manual', 'k-bad', 'Meets the checks')$$,
  '23514', null, 'conclusion must be one of the three exact strings');

select * from finish();
rollback;
