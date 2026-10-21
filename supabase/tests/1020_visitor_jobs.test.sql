-- Migrations 20261015009000 and 20261015009100: the visitor research trigger exists and visitor jobs never count toward the scan run status. 5 assertions.
begin;
create extension if not exists pgtap with schema extensions;
select plan(5);

create temp table stages(stage job_stage, ord int, key text default 'k');
insert into stages (stage, ord) values ('fx',1),('universe_sweep',2),('identity',3),('eur_catalogue',4),('fetch_bars',5),('compute',6),('rank_signals',7),('classify',8),('publish',9),('portfolio_scan',10),('news',11),('eur_resolve',12),('research',13),('classify',14),('publish',15),('digest',16);
update stages set key = case ord when 16 then 'digest' when 8 then 'classify:initial' when 9 then 'publish:initial' when 14 then 'classify:final' when 15 then 'publish:final' else key end;

-- 1: a visitor report can be stored
insert into companies (id, name, name_normalized, country) values ('96000000-0000-4000-8000-000000000001', 'Visitor Co', 'visitor co', 'United States');
insert into securities (id, company_id, yahoo_symbol, exchange_code, currency, currency_major, quote_type, is_canonical)
values ('96000000-0000-4000-8000-000000000002', '96000000-0000-4000-8000-000000000001', 'VIS', 'NMS', 'USD', 'USD', 'EQUITY', true);
select lives_ok($$insert into research_reports (security_id, company_id, trigger, status, visibility, idempotency_key)
  values ('96000000-0000-4000-8000-000000000002', '96000000-0000-4000-8000-000000000001', 'visitor', 'queued', 'public', 'visitor-k1')$$,
  'a research report with trigger visitor is accepted');

-- 2: a finished run (deadline in the future) with a queued visitor job stays complete
insert into scan_runs (id, scan_date_local, settings_snapshot) values ('96000000-0000-4000-8000-0000000000a1', '2099-01-01', '{}');
insert into scan_jobs (scan_run_id, stage, key, status, attempts, finished_at)
select '96000000-0000-4000-8000-0000000000a1', stage, key, 'done', 1, now() from stages;
select is(app.refresh_scan_status('96000000-0000-4000-8000-0000000000a1'), 'complete'::scan_status, 'the run is complete before the visitor job');
insert into scan_jobs (scan_run_id, stage, key, status, payload) values ('96000000-0000-4000-8000-0000000000a1', 'research', 'research:visitor', 'queued', '{"trigger": "visitor"}');
select app.refresh_scan_status('96000000-0000-4000-8000-0000000000a1');
select ok((select status = 'complete' and finished_at is not null from scan_runs where id = '96000000-0000-4000-8000-0000000000a1'),
          'a queued visitor job does not re-open a complete run');

-- 3: past the 22:00 deadline the sweep kills an ordinary open job but not the visitor job
insert into scan_runs (id, scan_date_local, settings_snapshot) values ('96000000-0000-4000-8000-0000000000a2', date '2001-01-02', '{}');
insert into scan_jobs (scan_run_id, stage, key, status, attempts, finished_at)
select '96000000-0000-4000-8000-0000000000a2', stage, key, 'done', 1, now() from stages where ord <= 12;
insert into scan_jobs (scan_run_id, stage, key, status, payload) values
  ('96000000-0000-4000-8000-0000000000a2', 'research', 'research:visitor', 'queued', '{"trigger": "visitor"}'),
  ('96000000-0000-4000-8000-0000000000a2', 'research', 'research:ordinary', 'queued', '{"trigger": "new_discount"}');
select app.refresh_scan_status('96000000-0000-4000-8000-0000000000a2');
select is((select status::text from scan_jobs where key = 'research:visitor' and scan_run_id = '96000000-0000-4000-8000-0000000000a2'), 'queued', 'the deadline sweep leaves a visitor job alone');
select is((select status::text from scan_jobs where key = 'research:ordinary' and scan_run_id = '96000000-0000-4000-8000-0000000000a2'), 'dead', 'control: the sweep kills an ordinary open job');

select * from finish();
rollback;
