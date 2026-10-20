begin;
create extension if not exists pgtap with schema extensions;
select plan(104);

-- =====================================================================================================
-- app.start_daily_scan: DST-safe 10:00 Europe/Sofia start (7.2)
-- =====================================================================================================
select isnt(app.start_daily_scan('2026-03-29 07:00:00+00'), null, '2026-03-29 07:00Z (already EEST, 10:00 local) starts a scan');
select is((select count(*)::int from scan_runs where scan_date_local = '2026-03-29'), 1, 'one run for the spring change day');
select is(app.start_daily_scan('2026-03-29 08:00:00+00'), null, '2026-03-29 08:00Z (11:00 local) does nothing');
select is((select count(*)::int from scan_runs where scan_date_local = '2026-03-29'), 1, 'still exactly one run on 2026-03-29');

select is(app.start_daily_scan('2026-10-25 07:00:00+00'), null, '2026-10-25 07:00Z (09:00 EET) does nothing');
select is((select count(*)::int from scan_runs where scan_date_local = '2026-10-25'), 0, 'no run yet on the autumn change day');
select isnt(app.start_daily_scan('2026-10-25 08:00:00+00'), null, '2026-10-25 08:00Z (10:00 EET) starts a scan');
select is((select count(*)::int from scan_runs where scan_date_local = '2026-10-25'), 1, 'one run for the autumn change day');

select isnt(app.start_daily_scan('2026-07-15 07:00:00+00'), null, 'ordinary summer day: the 07:00Z entry starts');
select is(app.start_daily_scan('2026-07-15 08:00:00+00'), null, 'ordinary summer day: the 08:00Z entry returns null');
select is(app.start_daily_scan('2026-01-15 07:00:00+00'), null, 'ordinary winter day: the 07:00Z entry returns null');
select isnt(app.start_daily_scan('2026-01-15 08:00:00+00'), null, 'ordinary winter day: the 08:00Z entry starts');

select is(app.start_daily_scan('2026-07-15 07:00:00+00'), null, 'a second call for the same instant is an idempotent no-op');
select is((select count(*)::int from scan_runs where scan_date_local = '2026-07-15'), 1, 'still one run for 2026-07-15');
select is((select digest_cutoff_at from scan_runs where scan_date_local = '2026-07-15'), '2026-07-15 10:00:00+00'::timestamptz, 'summer cut-off is 13:00 EEST = 10:00Z');
select is((select digest_cutoff_at from scan_runs where scan_date_local = '2026-01-15'), '2026-01-15 11:00:00+00'::timestamptz, 'winter cut-off is 13:00 EET = 11:00Z');
select is((select scan_date_local from scan_runs where started_at = '2026-10-25 08:00:00+00'), '2026-10-25'::date, 'scan_date_local is the Sofia date');

select is((select count(*)::int from scan_jobs j join scan_runs r on r.id = j.scan_run_id where r.scan_date_local = '2026-07-15'), 1, 'only the fx job is seeded');
select is((select j.stage::text || ':' || j.key || ':' || j.priority from scan_jobs j join scan_runs r on r.id = j.scan_run_id where r.scan_date_local = '2026-07-15'), 'fx:all:10', 'fx job key and priority');
select is((select settings_snapshot -> 'indicator' ->> 'length' from scan_runs where scan_date_local = '2026-07-15'), '2500', 'settings are snapshotted');
select ok((select settings_snapshot ? 'pipeline' and settings_snapshot ? 'universe' from scan_runs where scan_date_local = '2026-07-15'), 'universe and pipeline settings are snapshotted too');
select is((select count(*)::int from scan_events e join scan_runs r on r.id = e.scan_run_id where r.scan_date_local = '2026-07-15' and e.event = 'scan_started'), 1, 'scan_started event');

select isnt(app.start_daily_scan('2026-11-02 05:00:00+00', true, 'manual', '{"provider_mode":"fixture","fixture_set":"day1"}'), null, 'a forced start works outside the Sofia hour');
select is((select settings_snapshot ->> 'provider_mode' from scan_runs where scan_date_local = '2026-11-02'), 'fixture', 'snapshot extra is merged (fixture mode marker)');
select is((select trigger from scan_runs where scan_date_local = '2026-11-02'), 'manual', 'manual trigger recorded');
select is(app.start_daily_scan('2026-11-02 05:30:00+00', true, 'manual'), null, 'a second forced start for the same date creates nothing');

select isnt(app.ensure_scan_today('2026-11-10 08:30:00+00'), null, 'catch-up at 10:30 local starts the missing scan');
select is((select trigger from scan_runs where scan_date_local = '2026-11-10'), 'cron_catchup', 'catch-up trigger recorded');
select is(app.ensure_scan_today('2026-11-10 09:30:00+00'), null, 'catch-up does nothing when the run exists');
select is(app.ensure_scan_today('2026-11-11 07:00:00+00'), null, 'catch-up does nothing at 09:00 local (too early)');
select is(app.ensure_scan_today('2026-11-11 11:30:00+00'), null, 'catch-up does nothing at 13:30 local (too late)');
select isnt(app.ensure_scan_today('2026-11-11 10:30:00+00'), null, 'catch-up works at 12:30 local');

-- =====================================================================================================
-- seed_stage and next_stage_to_seed
-- =====================================================================================================
insert into scan_runs (id, scan_date_local, settings_snapshot) values ('00000000-0000-0000-0000-0000000000a1', date '2030-01-01' + 20, '{}');
select is(app.next_stage_to_seed('00000000-0000-0000-0000-0000000000a1'), 'fx'::job_stage, 'a run without jobs starts with fx');
select is(app.seed_stage('00000000-0000-0000-0000-0000000000a1', 'fx', array['all']), 1, 'seed_stage inserts one job');
select is(app.next_stage_to_seed('00000000-0000-0000-0000-0000000000a1'), null, 'nothing is seeded while fx is open');
update scan_jobs set status = 'done' where scan_run_id = '00000000-0000-0000-0000-0000000000a1';
select is(app.next_stage_to_seed('00000000-0000-0000-0000-0000000000a1'), 'universe_sweep'::job_stage, 'universe_sweep follows a finished fx');
select is(app.seed_stage('00000000-0000-0000-0000-0000000000a1', 'universe_sweep', array['NMS','GER','HKG'], '[{"n":1},{"n":2},{"n":3}]'::jsonb, array[30,10,20]), 3, 'three sweep jobs seeded');
select is(app.seed_stage('00000000-0000-0000-0000-0000000000a1', 'universe_sweep', array['NMS','GER','HKG']), 0, 'seeding the same keys again creates nothing (idempotent)');
select is((select payload ->> 'n' from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000a1' and key = 'GER'), '2', 'payloads are aligned with keys');
select is((select priority from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000a1' and key = 'HKG'), 20, 'priorities are aligned with keys');
update scan_jobs set status = 'done' where scan_run_id = '00000000-0000-0000-0000-0000000000a1' and key <> 'GER';
select is(app.next_stage_to_seed('00000000-0000-0000-0000-0000000000a1'), null, 'one open sweep job blocks the next stage');
update scan_jobs set status = 'dead' where scan_run_id = '00000000-0000-0000-0000-0000000000a1' and key = 'GER';
select is(app.next_stage_to_seed('00000000-0000-0000-0000-0000000000a1'), 'identity'::job_stage, 'a dead non-critical job does not block the pipeline');
select is(app.seed_stage('00000000-0000-0000-0000-0000000000a1', 'identity', array[]::text[]), 0, 'an empty stage inserts a done marker');
select is((select status::text from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000a1' and stage = 'identity' and key = '_empty'), 'done', 'the _empty marker is done');
select is(app.next_stage_to_seed('00000000-0000-0000-0000-0000000000a1'), 'eur_catalogue'::job_stage, 'eur_catalogue follows identity (P6)');
select is(app.seed_stage('00000000-0000-0000-0000-0000000000a1', 'eur_catalogue', array['eur_catalogue:2030-W01']), 1, 'the weekly import job is seeded');
update scan_jobs set status = 'done' where scan_run_id = '00000000-0000-0000-0000-0000000000a1' and stage = 'eur_catalogue';
select is(app.next_stage_to_seed('00000000-0000-0000-0000-0000000000a1'), 'fetch_bars'::job_stage, 'the pipeline moves past an empty stage and the finished eur_catalogue job');

insert into scan_runs (id, scan_date_local, settings_snapshot) values ('00000000-0000-0000-0000-0000000000a2', date '2030-01-01' + 21, '{}');
insert into scan_jobs (scan_run_id, stage, key, status) values ('00000000-0000-0000-0000-0000000000a2', 'fx', 'all', 'dead');
select is(app.next_stage_to_seed('00000000-0000-0000-0000-0000000000a2'), null, 'a dead fx stops the pipeline');

-- =====================================================================================================
-- claim_jobs: stage caps, priorities, not_before, stage filter, leases
-- =====================================================================================================
-- claims are global across runs: neutralise the fx jobs that the start_daily_scan tests above created
update scan_jobs set status = 'done', lease_until = null where status in ('queued', 'leased', 'failed');
insert into scan_runs (id, scan_date_local, settings_snapshot) values ('00000000-0000-0000-0000-0000000000b1', date '2030-01-01' + 22, '{}');
select app.seed_stage('00000000-0000-0000-0000-0000000000b1', 'fetch_bars', array['bars:0','bars:1','bars:2','bars:3','bars:4']);
select app.seed_stage('00000000-0000-0000-0000-0000000000b1', 'compute', array['compute:0']);

select is((select count(*)::int from app.claim_jobs('worker-1', 5, interval '180 seconds', array['fetch_bars']::job_stage[], '{"fetch_bars":2}')), 2, 'the stage cap of 2 limits one claim');
select is((select count(*)::int from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000b1' and status = 'leased' and leased_by = 'worker-1' and attempts = 1), 2, 'claimed jobs are leased to the worker with attempts = 1');
select is((select count(*)::int from app.claim_jobs('worker-2', 5, interval '180 seconds', array['fetch_bars']::job_stage[], '{"fetch_bars":2}')), 0, 'a second worker cannot exceed the stage cap');
select is((select status::text from scan_runs where id = '00000000-0000-0000-0000-0000000000b1'), 'running', 'the first claim moves the run to running');
select is((select count(*)::int from app.claim_jobs('worker-2', 5, interval '180 seconds', array['compute']::job_stage[], '{"fetch_bars":2}')), 1, 'another stage is not blocked by the fetch_bars cap');
update scan_jobs set status = 'done', lease_until = null where scan_run_id = '00000000-0000-0000-0000-0000000000b1' and key = 'bars:0';
select is((select count(*)::int from app.claim_jobs('worker-2', 5, interval '180 seconds', array['fetch_bars']::job_stage[], '{"fetch_bars":2}')), 1, 'a finished job frees one slot');
select is((select count(*)::int from app.claim_jobs('worker-3', 5, interval '180 seconds', array['fetch_bars']::job_stage[])), 2, 'without a cap the remaining queued jobs are claimed, never one already leased');
select is((select count(distinct id)::int from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000b1' and status = 'leased'), 6 - 1 - 0, 'every job is leased to exactly one worker (no double claim)');

insert into scan_runs (id, scan_date_local, settings_snapshot) values ('00000000-0000-0000-0000-0000000000b2', date '2030-01-01' + 23, '{}');
select app.seed_stage('00000000-0000-0000-0000-0000000000b2', 'fetch_bars', array['a','b','c'], null, array[50,10,30]);
select is((select array_agg(key) from app.claim_jobs('w', 3, interval '1 minute', array['fetch_bars']::job_stage[])), array['b','c','a'], 'jobs are claimed in priority order');
update scan_jobs set status = 'queued', lease_until = null, leased_by = null, not_before = now() + interval '1 hour' where scan_run_id = '00000000-0000-0000-0000-0000000000b2' and key = 'a';
select is((select count(*)::int from app.claim_jobs('w', 3, interval '1 minute', array['fetch_bars']::job_stage[]) where key = 'a'), 0, 'not_before in the future is not claimable');

insert into scan_runs (id, scan_date_local, settings_snapshot) values ('00000000-0000-0000-0000-0000000000b3', date '2030-01-01' + 24, '{}');
select app.seed_stage('00000000-0000-0000-0000-0000000000b3', 'fx', array['all']);
select app.seed_stage('00000000-0000-0000-0000-0000000000b3', 'compute', array['c0']);
select is((select array_agg(stage::text) from app.claim_jobs('w', 5, interval '1 minute', array['fx']::job_stage[])), array['fx'], 'p_stages filters the claim to the listed stages');
update scan_jobs set status = 'done', lease_until = null where status in ('queued', 'leased', 'failed');

-- lease expiry and the reaper
insert into scan_runs (id, scan_date_local, settings_snapshot) values ('00000000-0000-0000-0000-0000000000b4', date '2030-01-01' + 25, '{}');
select app.seed_stage('00000000-0000-0000-0000-0000000000b4', 'compute', array['x']);
select app.claim_jobs('w-dead', 1, interval '180 seconds', array['compute']::job_stage[]) is not null;
update scan_jobs set lease_until = now() - interval '1 second' where scan_run_id = '00000000-0000-0000-0000-0000000000b4';
select is(app.reap_expired_leases(), 1, 'an expired lease is reaped');
select is((select status::text from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000b4'), 'queued', 'the reaped job is queued again');
select is((select count(*)::int from app.claim_jobs('w2', 1, interval '1 minute', array['compute']::job_stage[]) where scan_run_id = '00000000-0000-0000-0000-0000000000b4'), 0, 'the reaped job waits 30 seconds (not_before)');
update scan_jobs set not_before = now() - interval '1 second' where scan_run_id = '00000000-0000-0000-0000-0000000000b4';
select is((select attempts from app.claim_jobs('w2', 1, interval '1 minute', array['compute']::job_stage[]) where scan_run_id = '00000000-0000-0000-0000-0000000000b4'), 2, 'a recovered job is claimed again with attempts = 2');
update scan_jobs set lease_until = now() - interval '1 second', attempts = max_attempts where scan_run_id = '00000000-0000-0000-0000-0000000000b4';
select app.reap_expired_leases();
select is((select status::text from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000b4'), 'dead', 'a job whose lease expires at max_attempts becomes dead');

-- =====================================================================================================
-- fail_job, complete_job, defer_job
-- =====================================================================================================
insert into scan_runs (id, scan_date_local, settings_snapshot) values ('00000000-0000-0000-0000-0000000000c1', date '2030-01-01' + 26, '{}');
select app.seed_stage('00000000-0000-0000-0000-0000000000c1', 'compute', array['flaky']);
do $$
declare i int; v_id bigint;
begin
  select id into v_id from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000c1';
  for i in 1 .. 4 loop
    perform app.claim_jobs('w', 1, interval '1 minute', array['compute']::job_stage[]);
    perform app.fail_job(v_id, 'boom ' || i);
    update scan_jobs set not_before = now() - interval '1 second' where id = v_id;
    if i = 1 then
      perform set_config('test.after_first', (select extract(epoch from (not_before - now()))::text from scan_jobs where id = v_id), true);
    end if;
  end loop;
end $$;
select is((select status::text || ':' || attempts from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000c1'), 'failed:4', 'four failures leave the job retryable');
select app.claim_jobs('w', 1, interval '1 minute', array['compute']::job_stage[]);
select is(app.fail_job((select id from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000c1'), 'boom 5'), 'dead'::job_status, 'the fifth failure (max_attempts = 5) is dead');
select is((select last_error from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000c1'), 'boom 5', 'the error is recorded');

insert into scan_runs (id, scan_date_local, settings_snapshot) values ('00000000-0000-0000-0000-0000000000c2', date '2030-01-01' + 27, '{}');
select app.seed_stage('00000000-0000-0000-0000-0000000000c2', 'compute', array['a','b','c']);
select app.claim_jobs('w', 3, interval '1 minute', array['compute']::job_stage[]);
select is(app.fail_job((select id from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000c2' and key = 'a'), 'e'), 'failed'::job_status, 'a first failure schedules a retry');
select ok((select not_before between now() + interval '59 seconds' and now() + interval '76 seconds' from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000c2' and key = 'a'), 'the first backoff is 1 minute plus up to 25% jitter');
select is(app.fail_job((select id from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000c2' and key = 'b'), 'fatal config', null, true), 'dead'::job_status, 'a fatal failure is dead at once');
select is(app.fail_job((select id from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000c2' and key = 'c'), 'e', interval '10 seconds'), 'failed'::job_status, 'an explicit retry interval is accepted');
select ok((select not_before between now() + interval '9 seconds' and now() + interval '11 seconds' from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000c2' and key = 'c'), 'the explicit interval is used');

-- fail_job lease-state guard
insert into scan_runs (id, scan_date_local, settings_snapshot) values ('00000000-0000-0000-0000-0000000000c9', date '2030-01-01' + 60, '{}');
select app.seed_stage('00000000-0000-0000-0000-0000000000c9', 'compute', array['d','o','m']);
select app.claim_jobs('w1', 3, interval '1 minute', array['compute']::job_stage[]);
select app.complete_job((select id from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000c9' and key = 'd'), '{}');
select is(app.fail_job((select id from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000c9' and key = 'd'), 'late', null, true), null::job_status, 'failing a done job returns null');
select is((select status::text from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000c9' and key = 'd'), 'done', 'failing a done job leaves it done');
select is(app.fail_job((select id from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000c9' and key = 'o'), 'not mine', null, false, 'w2'), null::job_status, 'failing a job leased by another worker returns null');
select is((select status::text || ':' || leased_by from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000c9' and key = 'o'), 'leased:w1', 'and leaves it leased by its owner');
select is(app.fail_job((select id from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000c9' and key = 'm'), 'mine', null, false, 'w1'), 'failed'::job_status, 'failing ones own leased job still backs off');

insert into scan_runs (id, scan_date_local, settings_snapshot) values ('00000000-0000-0000-0000-0000000000c3', date '2030-01-01' + 28, '{}');
select app.seed_stage('00000000-0000-0000-0000-0000000000c3', 'compute', array['x','y']);
select app.claim_jobs('w', 2, interval '1 minute', array['compute']::job_stage[]);
select app.complete_job((select id from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000c3' and key = 'x'), '{"ok":true}');
select is((select status::text || ':' || (result ->> 'ok') from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000c3' and key = 'x'), 'done:true', 'complete_job stores the result');
update scan_jobs set status = 'queued', lease_until = null where scan_run_id = '00000000-0000-0000-0000-0000000000c3' and key = 'y';
select app.complete_job((select id from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000c3' and key = 'y'), '{}');
select is((select status::text from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000c3' and key = 'y'), 'queued', 'a job that lost its lease cannot be completed by the old worker');
select app.claim_jobs('w', 1, interval '1 minute', array['compute']::job_stage[]);
select app.defer_job((select id from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000c3' and key = 'y'), interval '90 seconds', 'breaker_open');
select is((select status::text || ':' || attempts || ':' || last_error from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000c3' and key = 'y'), 'queued:1:breaker_open', 'defer_job requeues without consuming an attempt');
select ok((select not_before > now() + interval '80 seconds' from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000c3' and key = 'y'), 'defer_job sets not_before');

-- =====================================================================================================
-- refresh_scan_status (7.6)
-- P2 extends the pipeline: classify and publish run twice (initial, final), news and research follow publish:initial (7.4); P5b adds portfolio_scan in between
-- =====================================================================================================
create temp table stages(stage job_stage, ord int, key text default 'k');
insert into stages (stage, ord) values ('fx',1),('universe_sweep',2),('identity',3),('fetch_bars',4),('compute',5),('rank_signals',6),('classify',7),('publish',8),('news',9),('research',10),('classify',11),('publish',12),('portfolio_scan',13),('digest',14),('eur_catalogue',15),('eur_resolve',16);
update stages set key = case ord when 14 then 'digest' when 7 then 'classify:initial' when 8 then 'publish:initial' when 11 then 'classify:final' when 12 then 'publish:final' else key end;

create function pg_temp.mk_run(p_id uuid, p_offset int, p_coverage jsonb default '{}', p_cutoff timestamptz default null, p_date date default null) returns void language sql as $$
  insert into scan_runs (id, scan_date_local, settings_snapshot, coverage, digest_cutoff_at) values (p_id, coalesce(p_date, date '2030-01-01' + p_offset), '{}', p_coverage, p_cutoff)
$$;
create function pg_temp.mk_all_done(p_id uuid) returns void language sql as $$
  insert into scan_jobs (scan_run_id, stage, key, status, attempts, finished_at) select p_id, stage, key, 'done', 1, now() from stages
$$;

select pg_temp.mk_run('00000000-0000-0000-0000-0000000000d1', 30);
select pg_temp.mk_all_done('00000000-0000-0000-0000-0000000000d1');
select is(app.refresh_scan_status('00000000-0000-0000-0000-0000000000d1'), 'complete'::scan_status, 'every job done, none dead, no coverage gap: complete');
select ok((select finished_at is not null from scan_runs where id = '00000000-0000-0000-0000-0000000000d1'), 'complete sets finished_at');
select ok((select count(*) = 1 from scan_events where scan_run_id = '00000000-0000-0000-0000-0000000000d1' and event = 'scan_status_changed'), 'a status change is logged once');
select app.refresh_scan_status('00000000-0000-0000-0000-0000000000d1');
select ok((select count(*) = 1 from scan_events where scan_run_id = '00000000-0000-0000-0000-0000000000d1' and event = 'scan_status_changed'), 'refreshing again logs nothing');

select pg_temp.mk_run('00000000-0000-0000-0000-0000000000d2', 31);
select pg_temp.mk_all_done('00000000-0000-0000-0000-0000000000d2');
insert into scan_jobs (scan_run_id, stage, key, status, attempts) values ('00000000-0000-0000-0000-0000000000d2', 'universe_sweep', 'SAU', 'dead', 5);
select is(app.refresh_scan_status('00000000-0000-0000-0000-0000000000d2'), 'partial'::scan_status, 'a dead non-critical job makes a terminal run partial');
select ok((select finished_at is not null from scan_runs where id = '00000000-0000-0000-0000-0000000000d2'), 'a terminal partial run has finished_at');

select pg_temp.mk_run('00000000-0000-0000-0000-0000000000d3', 32);
select pg_temp.mk_all_done('00000000-0000-0000-0000-0000000000d3');
update scan_jobs set status = 'dead' where scan_run_id = '00000000-0000-0000-0000-0000000000d3' and stage = 'rank_signals';
select is(app.refresh_scan_status('00000000-0000-0000-0000-0000000000d3'), 'failed'::scan_status, 'a dead rank_signals job fails the run');

select pg_temp.mk_run('00000000-0000-0000-0000-0000000000d4', 33);
insert into scan_jobs (scan_run_id, stage, key, status, attempts) values ('00000000-0000-0000-0000-0000000000d4', 'fx', 'all', 'done', 1), ('00000000-0000-0000-0000-0000000000d4', 'universe_sweep', 'NMS', 'leased', 1);
select is(app.refresh_scan_status('00000000-0000-0000-0000-0000000000d4'), 'running'::scan_status, 'open jobs before the soft deadline: running');
select ok((select finished_at is null from scan_runs where id = '00000000-0000-0000-0000-0000000000d4'), 'a running scan has no finished_at');

select pg_temp.mk_run('00000000-0000-0000-0000-0000000000d5', 34);
insert into scan_jobs (scan_run_id, stage, key) values ('00000000-0000-0000-0000-0000000000d5', 'fx', 'all');
select is(app.refresh_scan_status('00000000-0000-0000-0000-0000000000d5'), 'queued'::scan_status, 'nothing leased yet: queued');

select pg_temp.mk_run('00000000-0000-0000-0000-0000000000d6', 35);
insert into scan_jobs (scan_run_id, stage, key, status, attempts) values ('00000000-0000-0000-0000-0000000000d6', 'fx', 'all', 'done', 1);
select is(app.refresh_scan_status('00000000-0000-0000-0000-0000000000d6'), 'running'::scan_status, 'between stages (later stages not seeded yet) the run is still running, never complete');

select pg_temp.mk_run('00000000-0000-0000-0000-0000000000d7', 36, '{}', now() - interval '1 hour');
insert into scan_jobs (scan_run_id, stage, key, status, attempts) values ('00000000-0000-0000-0000-0000000000d7', 'fx', 'all', 'done', 1), ('00000000-0000-0000-0000-0000000000d7', 'universe_sweep', 'NMS', 'queued', 0);
select is(app.refresh_scan_status('00000000-0000-0000-0000-0000000000d7'), 'partial'::scan_status, 'the soft deadline passed with open jobs: partial');
select ok((select finished_at is null from scan_runs where id = '00000000-0000-0000-0000-0000000000d7'), 'a partial run with open jobs is not finished');
update scan_jobs set status = 'done' where scan_run_id = '00000000-0000-0000-0000-0000000000d7';
insert into scan_jobs (scan_run_id, stage, key, status, attempts) select '00000000-0000-0000-0000-0000000000d7', stage, key, 'done', 1 from stages where stage not in ('fx', 'universe_sweep');
select is(app.refresh_scan_status('00000000-0000-0000-0000-0000000000d7'), 'complete'::scan_status, 'a partial run becomes complete when the remaining jobs finish with no dead job');

select pg_temp.mk_run('00000000-0000-0000-0000-0000000000d8', 0, '{}', null, '2020-01-01');
insert into scan_jobs (scan_run_id, stage, key, status, attempts) values ('00000000-0000-0000-0000-0000000000d8', 'fx', 'all', 'done', 1), ('00000000-0000-0000-0000-0000000000d8', 'universe_sweep', 'NMS', 'leased', 1), ('00000000-0000-0000-0000-0000000000d8', 'universe_sweep', 'GER', 'queued', 0);
select is(app.refresh_scan_status('00000000-0000-0000-0000-0000000000d8'), 'failed'::scan_status, 'the hard deadline passed before rank_signals finished: failed');
select is((select count(*)::int from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000d8' and status = 'dead' and last_error = 'deadline'), 2, 'remaining jobs are set dead with last_error = deadline');

select pg_temp.mk_run('00000000-0000-0000-0000-0000000000d9', 37, '{"candidates":{"total":10,"processed":9,"failed":1,"unprocessed":0,"stale":0,"carried_forward":0,"insufficient_data":0}}');
select pg_temp.mk_all_done('00000000-0000-0000-0000-0000000000d9');
select is(app.refresh_scan_status('00000000-0000-0000-0000-0000000000d9'), 'partial'::scan_status, 'a failed security is a coverage gap: partial');

select pg_temp.mk_run('00000000-0000-0000-0000-0000000000da', 38, '{"candidates":{"total":10,"processed":7,"failed":0,"unprocessed":0,"stale":0,"carried_forward":0,"insufficient_data":3}}');
select pg_temp.mk_all_done('00000000-0000-0000-0000-0000000000da');
select is(app.refresh_scan_status('00000000-0000-0000-0000-0000000000da'), 'complete'::scan_status, 'insufficient_data is legitimate (short history), not a gap: complete');

select pg_temp.mk_run('00000000-0000-0000-0000-0000000000db', 39, '{"candidates":{"unprocessed":2}}');
select pg_temp.mk_all_done('00000000-0000-0000-0000-0000000000db');
select is(app.refresh_scan_status('00000000-0000-0000-0000-0000000000db'), 'partial'::scan_status, 'unprocessed candidates are a gap: partial');

-- a fixture run replays an old date: its deadlines are judged against its own start, so it is neither failed nor partial because of the real clock
insert into scan_runs (id, scan_date_local, settings_snapshot, started_at, digest_cutoff_at) values ('00000000-0000-0000-0000-0000000000dc', '2020-01-02', '{"provider_mode":"fixture"}', '2020-01-02 08:00+00', '2020-01-02 10:00+00');
insert into scan_jobs (scan_run_id, stage, key, status, attempts) values ('00000000-0000-0000-0000-0000000000dc', 'fx', 'all', 'done', 1), ('00000000-0000-0000-0000-0000000000dc', 'universe_sweep', 'NMS', 'leased', 1);
select is(app.refresh_scan_status('00000000-0000-0000-0000-0000000000dc'), 'running'::scan_status, 'a fixture run on a past date is still running (deadlines use its own clock)');
select is((select count(*)::int from scan_jobs where scan_run_id = '00000000-0000-0000-0000-0000000000dc' and status = 'dead'), 0, 'and none of its jobs is killed by the real hard deadline');

-- P5b: a run without holdings seeds only the always-present portfolio_scan jobs (premium, risk_set) and still completes
select pg_temp.mk_run('00000000-0000-0000-0000-0000000000dd', 40);
insert into scan_jobs (scan_run_id, stage, key, status, attempts, finished_at) select '00000000-0000-0000-0000-0000000000dd', stage, key, 'done', 1, now() from stages where stage <> 'portfolio_scan';
select is(app.refresh_scan_status('00000000-0000-0000-0000-0000000000dd'), 'running'::scan_status, 'portfolio_scan not seeded yet: the run is still running');
insert into scan_jobs (scan_run_id, stage, key, status, attempts, finished_at) values ('00000000-0000-0000-0000-0000000000dd', 'portfolio_scan', 'premium', 'done', 1, now()), ('00000000-0000-0000-0000-0000000000dd', 'portfolio_scan', 'risk_set', 'done', 1, now());
select is(app.refresh_scan_status('00000000-0000-0000-0000-0000000000dd'), 'complete'::scan_status, 'a run with no holdings (premium and risk_set only) completes');

select * from finish();
rollback;
