begin;
create extension if not exists pgtap with schema extensions;
truncate public.todays_discounts, public.signal_episodes, public.universe_membership_events, public.universe_snapshots, public.scan_security_results, public.scan_events, public.scan_jobs, public.market_cap_snapshots, public.scan_runs restart identity cascade;
select plan(51);

-- tables ---------------------------------------------------------------------------------------------
select has_table('public', t, 'table ' || t || ' exists')
  from unnest(array['profiles','exchanges','fx_rates','companies','securities','security_identity_overrides','price_series',
                    'market_cap_snapshots','quote_cache','app_settings','audit_events','scan_runs','scan_jobs','scan_events',
                    'scan_security_results','universe_snapshots','universe_membership_events','signal_episodes','todays_discounts']) as t;

-- enums ----------------------------------------------------------------------------------------------
select enum_has_labels('public', 'universe_mode', array['worldwide','us']);
select enum_has_labels('public', 'signal_kind', array['discount','premium1','premium2']);
select enum_has_labels('public', 'threshold_line', array['-3','-4','+1','+2']);
select enum_has_labels('public', 'scan_status', array['queued','running','partial','complete','failed']);
select enum_has_labels('public', 'job_status', array['queued','leased','done','failed','dead']);
select enum_has_labels('public', 'operational_category', array['green','amber','red','grey','pending']);
select enum_has_labels('public', 'freshness_status', array['fresh','stale','unavailable']);
select enum_has_labels('public', 'venue_class', array['primary','secondary_only','otc']);

-- seeds ----------------------------------------------------------------------------------------------
select cmp_ok((select count(*)::int from exchanges), '>=', 35, 'exchanges seeded');
select is((select count(*)::int from exchanges where us_primary), 3, 'NMS, NYQ and NGM are the US-primary exchanges');
select is((select array_agg(code order by code) from exchanges where us_primary), array['NGM','NMS','NYQ'], 'US-primary codes');
select is((select trading_days from exchanges where code = 'SAU'), '{7,1,2,3,4}'::int[], 'Saudi trading days are Sunday-Thursday');
select is((select count(*)::int from exchanges where venue_class <> 'primary' and screener_enabled), 0, 'secondary and OTC venues are never swept');
select is((select (value ->> 'length')::int from app_settings where key = 'indicator'), 2500, 'indicator length 2500');
select is((select (value ->> 'threshold_usd')::numeric from app_settings where key = 'universe'), 50000000000::numeric, 'threshold 50e9');
select is((select array_agg(key order by key) from app_settings), array['eur_catalogue','eur_catalogue_state','indicator','pipeline','providers','research','scan_cadence','universe'], 'settings keys');

-- fixtures for the constraint checks -------------------------------------------------------------------
insert into companies (id, name, name_normalized) values ('00000000-0000-0000-0000-0000000000c1', 'Acme Corp', 'acme');
insert into securities (id, company_id, yahoo_symbol, exchange_code, currency, currency_major, quote_type)
values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'ACME', 'NMS', 'USD', 'USD', 'EQUITY'),
       ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000c1', 'ACME.DE', 'GER', 'EUR', 'EUR', 'EQUITY');

-- uniqueness -----------------------------------------------------------------------------------------
select throws_ok($$insert into securities (company_id, yahoo_symbol, exchange_code, currency, currency_major, quote_type)
                   values ('00000000-0000-0000-0000-0000000000c1', 'ACME', 'NMS', 'USD', 'USD', 'EQUITY')$$, '23505', null, 'yahoo_symbol is unique');
update securities set is_canonical = true where id = '00000000-0000-0000-0000-0000000000a1';
select throws_ok($$update securities set is_canonical = true where id = '00000000-0000-0000-0000-0000000000a2'$$, '23505', null, 'one canonical security per company');
select throws_ok($$insert into fx_rates (rate_date, ccy, usd_per_unit, source) values ('2026-10-14', 'EUR', 1.1, 'frankfurter'), ('2026-10-14', 'EUR', 1.2, 'frankfurter')$$,
                 '23505', null, 'one fx row per (rate_date, ccy)');
select throws_ok($$insert into fx_rates (rate_date, ccy, usd_per_unit, source) values ('2026-10-14', 'XXX', 0, 'frankfurter')$$, '23514', null, 'fx rate must be positive');

-- price_series: equal-length arrays ----------------------------------------------------------------------
select lives_ok($$insert into price_series (security_id, bar_dates, open, high, low, close, volume, bar_count, first_bar_date, last_bar_date,
                                            last_session_date, last_close, retrieved_at, last_full_refresh_at)
                  values ('00000000-0000-0000-0000-0000000000a1', '{1,2}', '{1,1}', '{2,2}', '{0,0}', '{1,2}', '{5,5}', 2, '1970-01-02', '1970-01-03', '1970-01-03', 2, now(), now())$$,
                'a consistent price_series row is accepted');
select throws_ok($$insert into price_series (security_id, bar_dates, open, high, low, close, volume, bar_count, first_bar_date, last_bar_date,
                                             last_session_date, last_close, retrieved_at, last_full_refresh_at)
                   values ('00000000-0000-0000-0000-0000000000a2', '{1,2}', '{1,1}', '{2,2}', '{0,0}', '{1}', '{5,5}', 2, '1970-01-02', '1970-01-03', '1970-01-03', 2, now(), now())$$,
                 '23514', null, 'arrays of different length are rejected');
select throws_ok($$update price_series set bar_count = 3 where security_id = '00000000-0000-0000-0000-0000000000a1'$$, '23514', null, 'bar_count must match cardinality');

-- scan_jobs idempotency -------------------------------------------------------------------------------
insert into scan_runs (id, scan_date_local, settings_snapshot) values ('00000000-0000-0000-0000-0000000000f1', '2026-10-15', '{}');
insert into scan_jobs (scan_run_id, stage, key) values ('00000000-0000-0000-0000-0000000000f1', 'fx', 'all');
select throws_ok($$insert into scan_jobs (scan_run_id, stage, key) values ('00000000-0000-0000-0000-0000000000f1', 'fx', 'all')$$, '23505', null, 'UNIQUE (scan_run_id, stage, key)');
select throws_ok($$insert into scan_runs (scan_date_local, settings_snapshot) values ('2026-10-15', '{}')$$, '23505', null, 'scan_date_local is unique');
select throws_ok($$insert into scan_runs (scan_date_local, settings_snapshot, trigger) values ('2026-10-16', '{}', 'bogus')$$, '23514', null, 'trigger values are checked');

-- episodes: partial unique indexes and the closed check -------------------------------------------------
insert into signal_episodes (id, security_id, company_id, kind, mode, threshold_line, opened_scan_run_id, opened_session_date, opened_close, opened_line_value,
                             open_reason, last_evaluated_session_date)
values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'discount', 'worldwide', '-3',
        '00000000-0000-0000-0000-0000000000f1', '2026-10-14', 99, 100, 'new_entry', '2026-10-14');
select throws_ok($$insert into signal_episodes (security_id, company_id, kind, mode, threshold_line, opened_scan_run_id, opened_session_date, opened_close, opened_line_value, open_reason, last_evaluated_session_date)
                   values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'discount', 'worldwide', '-3', '00000000-0000-0000-0000-0000000000f1', '2026-10-14', 99, 100, 'new_entry', '2026-10-14')$$,
                 '23505', 'duplicate key value violates unique constraint "signal_one_active"', 'one active episode per (security, kind, mode, line)');
select throws_ok($$insert into signal_episodes (security_id, company_id, kind, mode, threshold_line, opened_scan_run_id, opened_session_date, opened_close, opened_line_value, open_reason, last_evaluated_session_date)
                   values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'discount', 'worldwide', '-4', '00000000-0000-0000-0000-0000000000f1', '2026-10-14', 85, 90, 'new_entry', '2026-10-14')$$,
                 '23505', 'duplicate key value violates unique constraint "signal_one_active_discount"', 'one active DISCOUNT per security and mode even across threshold lines');
select lives_ok($$insert into signal_episodes (security_id, company_id, kind, mode, threshold_line, opened_scan_run_id, opened_session_date, opened_close, opened_line_value, open_reason, last_evaluated_session_date)
                  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'discount', 'us', '-3', '00000000-0000-0000-0000-0000000000f1', '2026-10-14', 99, 100, 'new_entry', '2026-10-14')$$,
                'the same security may have an active discount in the other mode');
select throws_ok($$update signal_episodes set status = 'closed' where id = '00000000-0000-0000-0000-0000000000e1'$$, '23514', null, 'a closed episode needs closed_session_date');
select lives_ok($$update signal_episodes set status = 'closed', closed_session_date = '2026-10-15', close_reason = 'close_above_threshold' where id = '00000000-0000-0000-0000-0000000000e1'$$,
                'closing with a date is accepted');
select lives_ok($$insert into signal_episodes (security_id, company_id, kind, mode, threshold_line, opened_scan_run_id, opened_session_date, opened_close, opened_line_value, open_reason, last_evaluated_session_date)
                  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'discount', 'worldwide', '-3', '00000000-0000-0000-0000-0000000000f1', '2026-10-16', 98, 100, 'new_entry', '2026-10-16')$$,
                're-entry after a close opens a new episode');

select * from finish();
rollback;
