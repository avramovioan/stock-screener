begin;
create extension if not exists pgtap with schema extensions;
select plan(16);

insert into companies (id, name, name_normalized) values ('00000000-0000-0000-0000-0000000000c1', 'Acme Corp', 'acme');
insert into securities (id, company_id, yahoo_symbol, exchange_code, currency, currency_major, quote_type)
values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'ACME', 'NMS', 'USD', 'USD', 'EQUITY');
insert into scan_runs (id, scan_date_local, settings_snapshot) values ('00000000-0000-0000-0000-0000000000f1', '2030-03-01', '{}');
insert into signal_episodes (id, security_id, company_id, kind, mode, threshold_line, opened_scan_run_id, opened_session_date, opened_close, opened_line_value,
                             open_reason, last_evaluated_session_date)
values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'discount', 'worldwide', '-3',
        '00000000-0000-0000-0000-0000000000f1', '2030-02-27', 99, 100, 'new_entry', '2030-02-27');

create function pg_temp.open_doc() returns jsonb language sql as $$
  select jsonb_build_object('security_id', '00000000-0000-0000-0000-0000000000a1', 'company_id', '00000000-0000-0000-0000-0000000000c1',
         'kind', 'discount', 'mode', 'worldwide', 'threshold_line', '-4', 'opened_scan_run_id', '00000000-0000-0000-0000-0000000000f1',
         'opened_session_date', '2030-02-28', 'opened_close', 70, 'opened_line_value', 80, 'opened_rank', 11, 'open_reason', 'continuation',
         'notify', false, 'last_evaluated_session_date', '2030-02-28', 'rank_history', '[{"rank":11}]'::jsonb)
$$;

select is((app.transition_episode('00000000-0000-0000-0000-0000000000e1', 'threshold_changed', '2030-02-28', pg_temp.open_doc()) ->> 'threshold_line'), '-4',
          'the continuation is returned');
select is((select status::text || ' ' || close_reason || ' ' || closed_session_date from signal_episodes where id = '00000000-0000-0000-0000-0000000000e1'),
          'closed threshold_changed 2030-02-28', 'the old episode is closed in the same call');
select is((select closed_scan_run_id from signal_episodes where id = '00000000-0000-0000-0000-0000000000e1'), '00000000-0000-0000-0000-0000000000f1'::uuid, 'closed by the run that opened the continuation');
select is((select count(*)::int from signal_episodes where continues_episode_id = '00000000-0000-0000-0000-0000000000e1' and status = 'active'), 1, 'one active continuation');
select is((select notify from signal_episodes where continues_episode_id = '00000000-0000-0000-0000-0000000000e1'), false, 'the continuation is silent');
select is((select open_reason from signal_episodes where continues_episode_id = '00000000-0000-0000-0000-0000000000e1'), 'continuation', 'open_reason continuation');

-- idempotent retry: nothing is duplicated and the existing continuation is returned
select is((app.transition_episode('00000000-0000-0000-0000-0000000000e1', 'threshold_changed', '2030-02-28', pg_temp.open_doc()) ->> 'threshold_line'), '-4',
          'a retry returns the existing continuation');
select is((select count(*)::int from signal_episodes where security_id = '00000000-0000-0000-0000-0000000000a1'), 2, 'a retry creates no third episode');

-- atomicity: a failing insert rolls the close back
delete from signal_episodes where continues_episode_id = '00000000-0000-0000-0000-0000000000e1';
update signal_episodes set status = 'active', closed_scan_run_id = null, closed_session_date = null, close_reason = null where id = '00000000-0000-0000-0000-0000000000e1';
select throws_ok($$select app.transition_episode('00000000-0000-0000-0000-0000000000e1', 'threshold_changed', '2030-02-28',
                    pg_temp.open_doc() || '{"opened_close": null}'::jsonb)$$, '23502', null, 'an invalid continuation fails');
select is((select status::text from signal_episodes where id = '00000000-0000-0000-0000-0000000000e1'), 'active', 'the failed transition left the episode active');

-- close only, and unknown / foreign sessions
select is((app.transition_episode('00000000-0000-0000-0000-0000000000e1', 'threshold_changed', '2030-02-28') ->> 'status'), 'closed', 'p_open null closes only');
select is((select count(*)::int from signal_episodes where continues_episode_id = '00000000-0000-0000-0000-0000000000e1'), 0, 'and opens nothing');
select throws_ok($$select app.transition_episode('00000000-0000-0000-0000-0000000000e9', 'threshold_changed', '2030-02-28')$$, 'P0002', 'episode_not_found', 'unknown episode');
select throws_ok($$select app.transition_episode('00000000-0000-0000-0000-0000000000e1', 'threshold_changed', '2030-03-05')$$, 'P0001', 'episode_closed_for_another_session', 'a different session is refused');

select is(has_function_privilege('anon', 'app.transition_episode(uuid,text,date,jsonb)', 'execute'), false, 'anon cannot execute transition_episode');
select is(has_function_privilege('service_role', 'app.transition_episode(uuid,text,date,jsonb)', 'execute'), true, 'service_role can execute transition_episode');

select * from finish();
rollback;
