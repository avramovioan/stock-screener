begin;
create extension if not exists pgtap with schema extensions;
select plan(23);

-- P2 stage slots: ... rank_signals, classify:initial, publish:initial, news, research, classify:final, publish:final
insert into scan_runs (id, scan_date_local, settings_snapshot)
values ('00000000-0000-0000-0000-0000000000b1', date '2031-02-01', '{}');
insert into scan_jobs (scan_run_id, stage, key, status)
select '00000000-0000-0000-0000-0000000000b1', s, 'x', 'done'
  from unnest(array['fx','universe_sweep','identity','eur_catalogue','fetch_bars','compute','rank_signals']::job_stage[]) as s;

select is(app.next_stage_to_seed('00000000-0000-0000-0000-0000000000b1'), 'classify'::job_stage, 'classify (initial) follows rank_signals');
insert into scan_jobs (scan_run_id, stage, key, status) values ('00000000-0000-0000-0000-0000000000b1', 'classify', 'classify:initial', 'queued');
select is(app.next_stage_to_seed('00000000-0000-0000-0000-0000000000b1'), null, 'an open classify:initial blocks publish');
update scan_jobs set status = 'done' where scan_run_id = '00000000-0000-0000-0000-0000000000b1' and stage = 'classify';
select is(app.next_stage_to_seed('00000000-0000-0000-0000-0000000000b1'), 'publish'::job_stage, 'publish (initial) follows classify:initial');
-- portfolio_scan (P5b, stage 8) sits between publish:initial and news: holdings chunks, premium and risk_set
insert into scan_jobs (scan_run_id, stage, key, status) values ('00000000-0000-0000-0000-0000000000b1', 'publish', 'publish:initial', 'done');
select is(app.next_stage_to_seed('00000000-0000-0000-0000-0000000000b1'), 'portfolio_scan'::job_stage, 'portfolio_scan follows publish:initial');
insert into scan_jobs (scan_run_id, stage, key, status) values ('00000000-0000-0000-0000-0000000000b1', 'portfolio_scan', 'premium', 'queued'), ('00000000-0000-0000-0000-0000000000b1', 'portfolio_scan', 'risk_set', 'leased');
select is(app.next_stage_to_seed('00000000-0000-0000-0000-0000000000b1'), null, 'an open portfolio_scan job blocks news');
update scan_jobs set status = 'done' where scan_run_id = '00000000-0000-0000-0000-0000000000b1' and stage = 'portfolio_scan';
select is(app.next_stage_to_seed('00000000-0000-0000-0000-0000000000b1'), 'news'::job_stage, 'news follows publish:initial');
select is(app.seed_stage('00000000-0000-0000-0000-0000000000b1', 'news', array[]::text[]), 0, 'an empty news stage leaves a done marker');
select is(app.next_stage_to_seed('00000000-0000-0000-0000-0000000000b1'), 'eur_resolve'::job_stage, 'eur_resolve (P6, stage 9) follows news');
select is(app.seed_stage('00000000-0000-0000-0000-0000000000b1', 'eur_resolve', array[]::text[]), 0, 'a run without EUR candidates leaves a done marker');
select is(app.next_stage_to_seed('00000000-0000-0000-0000-0000000000b1'), 'research'::job_stage, 'research follows news');
insert into scan_jobs (scan_run_id, stage, key, status) values ('00000000-0000-0000-0000-0000000000b1', 'research', 'research:s1:new_discount:plan', 'leased');
select is(app.next_stage_to_seed('00000000-0000-0000-0000-0000000000b1'), null, 'an open research job blocks classify:final');
update scan_jobs set status = 'dead' where scan_run_id = '00000000-0000-0000-0000-0000000000b1' and stage = 'research';
select is(app.next_stage_to_seed('00000000-0000-0000-0000-0000000000b1'), 'classify'::job_stage, 'a dead research job does not block classify:final');
insert into scan_jobs (scan_run_id, stage, key, status) values ('00000000-0000-0000-0000-0000000000b1', 'classify', 'classify:final', 'queued');
select is(app.next_stage_to_seed('00000000-0000-0000-0000-0000000000b1'), null, 'an open classify:final blocks publish:final');
update scan_jobs set status = 'done' where scan_run_id = '00000000-0000-0000-0000-0000000000b1' and key = 'classify:final';
select is(app.next_stage_to_seed('00000000-0000-0000-0000-0000000000b1'), 'publish'::job_stage, 'publish (final) follows classify:final');
insert into scan_jobs (scan_run_id, stage, key, status) values ('00000000-0000-0000-0000-0000000000b1', 'publish', 'publish:final', 'done');
select is(app.next_stage_to_seed('00000000-0000-0000-0000-0000000000b1'), 'digest'::job_stage, 'digest follows publish:final');
insert into scan_jobs (scan_run_id, stage, key, status) values ('00000000-0000-0000-0000-0000000000b1', 'digest', 'digest:cutoff', 'done');
select is(app.next_stage_to_seed('00000000-0000-0000-0000-0000000000b1'), 'digest'::job_stage, 'a digest:cutoff job does not occupy the digest slot');
insert into scan_jobs (scan_run_id, stage, key, status) values ('00000000-0000-0000-0000-0000000000b1', 'digest', 'digest', 'done');
select is(app.next_stage_to_seed('00000000-0000-0000-0000-0000000000b1'), null, 'nothing is left after the digest job');

-- a run whose research stage was never seeded is not skipped by the initial keys alone
insert into scan_runs (id, scan_date_local, settings_snapshot)
values ('00000000-0000-0000-0000-0000000000b2', date '2031-02-02', '{}');
insert into scan_jobs (scan_run_id, stage, key, status)
select '00000000-0000-0000-0000-0000000000b2', s, 'x', 'done'
  from unnest(array['fx','universe_sweep','identity','eur_catalogue','fetch_bars','compute','rank_signals']::job_stage[]) as s;
insert into scan_jobs (scan_run_id, stage, key, status) values
  ('00000000-0000-0000-0000-0000000000b2', 'classify', 'classify:initial', 'done'),
  ('00000000-0000-0000-0000-0000000000b2', 'publish', 'publish:initial', 'done'),
  ('00000000-0000-0000-0000-0000000000b2', 'portfolio_scan', 'risk_set', 'done');
select is(app.next_stage_to_seed('00000000-0000-0000-0000-0000000000b2'), 'news'::job_stage, 'a P1-only run continues with news');
-- scan-control recompute deletes classify and publish jobs: both initial and final are re-seeded in order
delete from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000b1' and stage in ('classify', 'publish');
select is(app.next_stage_to_seed('00000000-0000-0000-0000-0000000000b1'), 'classify'::job_stage, 'after a recompute classify:initial is seeded again');
select is(app.refresh_scan_status('00000000-0000-0000-0000-0000000000b2') is not null, true, 'refresh_scan_status still evaluates with the new slots');



-- manual research jobs (research_now) never keep a run open and survive the 22:00 deadline sweep
insert into scan_runs (id, scan_date_local, settings_snapshot, started_at)
values ('00000000-0000-0000-0000-0000000000b3', date '2031-02-03', '{}', now());
insert into scan_jobs (scan_run_id, stage, key, status, attempts, payload)
select '00000000-0000-0000-0000-0000000000b3', s.stage::job_stage, s.key, 'done', 1, '{}'::jsonb
  from (values ('fx','x'),('universe_sweep','x'),('identity','x'),('eur_catalogue','x'),('fetch_bars','x'),('compute','x'),('rank_signals','x'),
               ('classify','classify:initial'),('publish','publish:initial'),('portfolio_scan','risk_set'),('news','x'),('eur_resolve','x'),('research','x'),
               ('classify','classify:final'),('publish','publish:final'),('digest','digest')) as s(stage, key);
insert into scan_jobs (scan_run_id, stage, key, status, payload)
values ('00000000-0000-0000-0000-0000000000b3', 'research', 'research:r1:plan', 'queued', '{"trigger":"manual"}');
select is(app.refresh_scan_status('00000000-0000-0000-0000-0000000000b3'), 'complete'::scan_status, 'an open manual research job does not keep a finished run open');
insert into scan_jobs (scan_run_id, stage, key, status, payload)
values ('00000000-0000-0000-0000-0000000000b3', 'research', 'research:r2:plan', 'queued', '{"trigger":"new_discount"}');
select is(app.refresh_scan_status('00000000-0000-0000-0000-0000000000b3'), 'running'::scan_status, 'a regular open research job still does');
insert into scan_runs (id, scan_date_local, settings_snapshot)
values ('00000000-0000-0000-0000-0000000000b4', date '2020-02-03', '{}');
insert into scan_jobs (scan_run_id, stage, key, status, payload) values
  ('00000000-0000-0000-0000-0000000000b4', 'rank_signals', 'rank', 'done', '{}'),
  ('00000000-0000-0000-0000-0000000000b4', 'research', 'research:r1:plan', 'queued', '{"trigger":"manual"}'),
  ('00000000-0000-0000-0000-0000000000b4', 'research', 'research:r2:plan', 'queued', '{"trigger":"new_discount"}');
select app.refresh_scan_status('00000000-0000-0000-0000-0000000000b4');
select is((select array_agg(status::text order by key) from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000b4' and stage = 'research'), array['queued', 'dead'], 'the deadline sweep kills regular jobs and spares the manual one');

select * from finish();
rollback;
