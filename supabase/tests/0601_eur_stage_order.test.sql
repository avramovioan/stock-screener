begin;
create extension if not exists pgtap with schema extensions;
select plan(6);

-- P6: eur_catalogue sits right after identity, eur_resolve right after news (spec 7.4); both complete with an empty seed.
insert into public.scan_runs (id, scan_date_local, settings_snapshot) values ('e2000000-0000-4000-8000-000000000001', '2031-03-01', '{}'::jsonb);
insert into public.scan_jobs (scan_run_id, stage, key, status) values
  ('e2000000-0000-4000-8000-000000000001', 'fx', 'all', 'done'),
  ('e2000000-0000-4000-8000-000000000001', 'universe_sweep', 'NMS', 'done'),
  ('e2000000-0000-4000-8000-000000000001', 'identity', 'group:0', 'done');
select is(app.next_stage_to_seed('e2000000-0000-4000-8000-000000000001'), 'eur_catalogue'::job_stage, 'eur_catalogue is seeded right after identity');
insert into public.scan_jobs (scan_run_id, stage, key, status) values ('e2000000-0000-4000-8000-000000000001', 'eur_catalogue', 'eur_catalogue:2031-W09', 'queued');
select is(app.next_stage_to_seed('e2000000-0000-4000-8000-000000000001')::text, null, 'fetch_bars waits while the eur_catalogue job is open');
update public.scan_jobs set status = 'done' where stage = 'eur_catalogue' and scan_run_id = 'e2000000-0000-4000-8000-000000000001';
select is(app.next_stage_to_seed('e2000000-0000-4000-8000-000000000001'), 'fetch_bars'::job_stage, 'fetch_bars follows the finished eur_catalogue job');

insert into public.scan_runs (id, scan_date_local, settings_snapshot) values ('e2000000-0000-4000-8000-000000000002', '2031-03-02', '{}'::jsonb);
insert into public.scan_jobs (scan_run_id, stage, key, status)
select 'e2000000-0000-4000-8000-000000000002', s.stage::job_stage, s.key, 'done'
  from (values ('fx','x'),('universe_sweep','x'),('identity','x'),('eur_catalogue','x'),('fetch_bars','x'),('compute','x'),('rank_signals','x'),
               ('classify','classify:initial'),('publish','publish:initial'),('portfolio_scan','risk_set'),('news','x')) as s(stage, key);
select is(app.next_stage_to_seed('e2000000-0000-4000-8000-000000000002'), 'eur_resolve'::job_stage, 'eur_resolve follows news');
select is(app.seed_stage('e2000000-0000-4000-8000-000000000002', 'eur_resolve', array[]::text[]), 0, 'no candidates: an empty seed leaves a done marker');
select is(app.next_stage_to_seed('e2000000-0000-4000-8000-000000000002'), 'research'::job_stage, 'research follows the finished eur_resolve slot');

select * from finish();
rollback;
