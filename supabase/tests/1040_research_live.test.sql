-- Migration 20261015009400: one visitor scan per company at a time (atomic accept) and Realtime for research_reports. 16 assertions.
begin;
create extension if not exists pgtap with schema extensions;
select plan(16);

insert into companies (id, name, name_normalized, country) values
  ('97000000-0000-4000-8000-000000000001', 'Live Co', 'live co', 'United States'),
  ('97000000-0000-4000-8000-000000000011', 'Other Live Co', 'other live co', 'United States');
insert into securities (id, company_id, yahoo_symbol, exchange_code, currency, currency_major, quote_type, is_canonical) values
  ('97000000-0000-4000-8000-000000000002', '97000000-0000-4000-8000-000000000001', 'LIVE', 'NMS', 'USD', 'USD', 'EQUITY', true),
  ('97000000-0000-4000-8000-000000000012', '97000000-0000-4000-8000-000000000011', 'LIV2', 'NMS', 'USD', 'USD', 'EQUITY', true);
insert into scan_runs (id, scan_date_local, settings_snapshot) values ('97000000-0000-4000-8000-0000000000a1', '2099-01-01', '{}');

-- 1-3: privileges
select is(has_function_privilege('service_role', 'public.accept_visitor_research(uuid, uuid, timestamptz, text, text, int, jsonb)', 'execute'), true, 'service_role may accept');
select is(has_function_privilege('anon', 'public.accept_visitor_research(uuid, uuid, timestamptz, text, text, int, jsonb)', 'execute'), false, 'anon may not accept');
select is(has_function_privilege('authenticated', 'public.accept_visitor_research(uuid, uuid, timestamptz, text, text, int, jsonb)', 'execute'), false, 'authenticated may not accept');

-- 4-6: the first request is accepted: a queued visitor report and a research job appear together
create temp table first_accept as
select * from public.accept_visitor_research(
  '97000000-0000-4000-8000-000000000002', '97000000-0000-4000-8000-0000000000a1', '2026-10-20T10:00:00Z',
  '97000000-0000-4000-8000-000000000002:visitor:2026-10-20T10:00:00.000Z',
  'research:97000000-0000-4000-8000-000000000002:visitor:plan:2026-10-20T10:00:00.000Z', 5,
  '{"security_id": "97000000-0000-4000-8000-000000000002", "trigger": "visitor", "scan_date_local": "2099-01-01", "accepted_at": "2026-10-20T10:00:00.000Z", "source": "visitor"}');
select is((select accepted from first_accept), true, 'the first request is accepted');
select results_eq(
  $$ select status::text, trigger::text, visibility::text, started_at, usage ->> 'source' from research_reports where id = (select report_id from first_accept) $$,
  $$ values ('queued', 'visitor', 'public', '2026-10-20T10:00:00Z'::timestamptz, 'visitor') $$,
  'the report row exists at once: queued, visitor, public, started at the accepted time, source visitor');
select is((select count(*)::int from scan_jobs where stage = 'research' and payload ->> 'security_id' = '97000000-0000-4000-8000-000000000002'), 1, 'one research job is queued with it');

-- 7-8: the second request while the first is queued is refused and names the in-flight report
select results_eq(
  $$ select accepted, report_id, started_at, requested_by from public.accept_visitor_research(
       '97000000-0000-4000-8000-000000000002', '97000000-0000-4000-8000-0000000000a1', '2026-10-20T10:00:30Z',
       'k-2', 'research:second', 5, '{}') $$,
  $$ select false, null::uuid, '2026-10-20T10:00:00Z'::timestamptz, 'visitor'::text $$,
  'a second request is refused with the first one''s start and requester');
select is((select count(*)::int from research_reports where security_id = '97000000-0000-4000-8000-000000000002'), 1, 'the refusal creates no report and no job');

-- 9: still refused while the report runs
update research_reports set status = 'running' where id = (select report_id from first_accept);
select is((select accepted from public.accept_visitor_research(
  '97000000-0000-4000-8000-000000000002', '97000000-0000-4000-8000-0000000000a1', '2026-10-20T10:01:00Z', 'k-3', 'research:third', 5, '{}')), false,
  'a running scan still blocks');

-- 10: a different company is not blocked
select is((select accepted from public.accept_visitor_research(
  '97000000-0000-4000-8000-000000000012', '97000000-0000-4000-8000-0000000000a1', '2026-10-20T10:01:00Z', 'k-other', 'research:other', 5, '{"security_id": "97000000-0000-4000-8000-000000000012"}')), true,
  'another company can be scanned at the same time');

-- 11-12: a complete (or failed) report with its job finished frees the company; the cooldown is the handler's job
update research_reports set status = 'complete', completed_at = now() where id = (select report_id from first_accept);
update scan_jobs set status = 'done', finished_at = now() where payload ->> 'security_id' = '97000000-0000-4000-8000-000000000002';
select is((select accepted from public.accept_visitor_research(
  '97000000-0000-4000-8000-000000000002', '97000000-0000-4000-8000-0000000000a1', '2026-10-20T10:05:00Z', 'k-4', 'research:fourth',
  5, '{"security_id": "97000000-0000-4000-8000-000000000002"}')), true, 'once the report is complete the company can be accepted again');
update research_reports set status = 'failed', error = 'x' where idempotency_key = 'k-4';
update scan_jobs set status = 'done', finished_at = now() where key = 'research:fourth';
select is((select accepted from public.accept_visitor_research(
  '97000000-0000-4000-8000-000000000002', '97000000-0000-4000-8000-0000000000a1', '2026-10-20T10:06:00Z', 'k-5', 'research:fifth',
  5, '{"security_id": "97000000-0000-4000-8000-000000000002"}')), true, 'a failed report with a finished job frees the company too');

-- 13: monitor reports coexist: a complete monitor report of the company does not block a visitor scan
update research_reports set status = 'complete' where security_id = '97000000-0000-4000-8000-000000000012' and trigger = 'visitor';
update scan_jobs set status = 'done', finished_at = now() where payload ->> 'security_id' = '97000000-0000-4000-8000-000000000012';
insert into research_reports (security_id, company_id, trigger, status, visibility, idempotency_key)
values ('97000000-0000-4000-8000-000000000012', '97000000-0000-4000-8000-000000000011', 'monitor_change', 'complete', 'holders', 'mon-1');
select is((select accepted from public.accept_visitor_research(
  '97000000-0000-4000-8000-000000000012', '97000000-0000-4000-8000-0000000000a1', '2026-10-20T11:00:00Z', 'k-6', 'research:sixth',
  5, '{"security_id": "97000000-0000-4000-8000-000000000012"}')), true, 'a complete monitor report does not block a visitor scan');

-- 14-16: Realtime
select ok(exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'research_reports'),
  'research_reports is in the supabase_realtime publication');
select is(has_table_privilege('anon', 'public.research_reports', 'select'), true, 'anon can select research_reports');
select ok(exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'research_reports' and policyname = 'research_reports_public' and 'anon' = any (roles)),
  'anon reads the public rows through the existing policy');

select * from finish();
rollback;
