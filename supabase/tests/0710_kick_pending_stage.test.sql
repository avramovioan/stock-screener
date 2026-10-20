begin;
create extension if not exists pgtap with schema extensions;
select plan(10);

-- Final fix wave A: kick_workers also fires for an active run whose next stage still has to be seeded (no queued job exists at a stage
-- boundary), claim_jobs locks stages in sorted order, and rank_signals may close an episode as left_universe.
delete from scan_runs; -- cascades to jobs; the transaction is rolled back
delete from vault.secrets where name in ('project_url', 'worker_tick_secret');
select vault.create_secret('http://example.invalid', 'project_url');
select vault.create_secret('dummy-secret-value-7f3a9c', 'worker_tick_secret');

create function pg_temp.kicks() returns int language plpgsql as $$
declare before_n int; after_n int;
begin
  select count(*) into before_n from net.http_request_queue where url like '%/worker-tick';
  perform app.kick_workers();
  select count(*) into after_n from net.http_request_queue where url like '%/worker-tick';
  return after_n - before_n;
end $$;
create function pg_temp.sofia_today() returns date language sql as $$ select (now() at time zone 'Europe/Sofia')::date $$;

-- (1) the stall: fx is done, nothing is queued, the next stage (universe_sweep) is not seeded yet
insert into scan_runs (id, scan_date_local, status, settings_snapshot) values ('00000000-0000-0000-0000-0000000000a7', pg_temp.sofia_today(), 'running', '{}');
insert into scan_jobs (scan_run_id, stage, key, status) values ('00000000-0000-0000-0000-0000000000a7', 'fx', 'all', 'done');
select is(pg_temp.kicks(), 1, 'a running run with a pending stage is kicked although no job is queued');

-- (2) a dead fx stage stops the pipeline: nothing to seed, nothing to kick
update scan_jobs set status = 'dead' where scan_run_id = '00000000-0000-0000-0000-0000000000a7';
select is(pg_temp.kicks(), 0, 'a run that cannot seed its next stage does not kick');
update scan_jobs set status = 'done' where scan_run_id = '00000000-0000-0000-0000-0000000000a7';

-- (3) cap: two distinct live leasers hold the workers, no third invocation
insert into scan_jobs (scan_run_id, stage, key, status, leased_by, lease_until) values
  ('00000000-0000-0000-0000-0000000000a7', 'research', 'r1', 'leased', 'w1', now() + interval '1 minute'),
  ('00000000-0000-0000-0000-0000000000a7', 'research', 'r2', 'leased', 'w2', now() + interval '1 minute');
select is(pg_temp.kicks(), 0, 'two distinct live leasers cap the kicks even with a pending stage');
delete from scan_jobs where stage = 'research';
select is(pg_temp.kicks(), 1, 'with the leasers gone the pending stage kicks again');

-- (4) only active runs count: complete / failed runs and runs older than Sofia yesterday never kick
update scan_runs set status = 'complete' where id = '00000000-0000-0000-0000-0000000000a7';
select is(pg_temp.kicks(), 0, 'a complete run does not kick');
update scan_runs set status = 'partial' where id = '00000000-0000-0000-0000-0000000000a7';
select is(pg_temp.kicks(), 1, 'a partial run with a pending stage kicks');
update scan_runs set scan_date_local = pg_temp.sofia_today() - 2 where id = '00000000-0000-0000-0000-0000000000a7';
select is(pg_temp.kicks(), 0, 'a run older than Sofia yesterday does not kick');

-- (5) claim_jobs takes its stage locks first and in sorted order
select ok(position('pg_advisory_xact_lock' in pg_get_functiondef('app.claim_jobs(text,int,interval,job_stage[],jsonb)'::regprocedure))
          < position('for update skip locked' in pg_get_functiondef('app.claim_jobs(text,int,interval,job_stage[],jsonb)'::regprocedure)),
          'claim_jobs locks the stages before it scans the rows');
select ok(pg_get_functiondef('app.claim_jobs(text,int,interval,job_stage[],jsonb)'::regprocedure) like '%unnest(p_stages)%order by 1%',
          'the stage locks are taken in sorted order');

-- (6) the new episode close reason is accepted
insert into companies (id, name, name_normalized) values ('00000000-0000-0000-0000-0000000000c7', 'Gone Corp', 'gone');
insert into securities (id, company_id, yahoo_symbol, exchange_code, currency, currency_major, quote_type)
values ('00000000-0000-0000-0000-0000000000b7', '00000000-0000-0000-0000-0000000000c7', 'GONE', 'NMS', 'USD', 'USD', 'EQUITY');
insert into signal_episodes (id, security_id, company_id, kind, mode, threshold_line, opened_scan_run_id, opened_session_date, opened_close, opened_line_value,
                             open_reason, last_evaluated_session_date)
values ('00000000-0000-0000-0000-0000000000d7', '00000000-0000-0000-0000-0000000000b7', '00000000-0000-0000-0000-0000000000c7', 'discount', 'worldwide', '-3',
        '00000000-0000-0000-0000-0000000000a7', '2030-02-27', 99, 100, 'new_entry', '2030-02-27');
select lives_ok($$update signal_episodes set status = 'closed', closed_session_date = '2030-02-27', close_reason = 'left_universe'
                  where id = '00000000-0000-0000-0000-0000000000d7'$$, 'left_universe is an allowed close reason');

select * from finish();
rollback;
