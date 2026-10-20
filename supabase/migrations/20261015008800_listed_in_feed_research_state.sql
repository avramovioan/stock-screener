-- Listed-in filter and research state in the feed (owner decisions 2026-10-19, spec 5.1, 5.4).
-- Forward-only and replay-safe (create or replace, drop-then-create, defaults with stored values winning). Nothing is rewritten.
--
-- 1) listing_country: the country of the exchange the company's canonical listing trades on. The "Listed in" filter of the
--    Company List (p_country) and of the discounts feed uses it; the country column keeps the company's home country (flags and the
--    identity line). An Irish-domiciled company on NYQ is listed in the United States; a US company whose canonical listing is
--    on LSE is not.
-- 2) research state in the feed: research_started_at, research_wait_reason, research_requested_by (usage ->> 'source') from the
--    security's newest in-flight report (queued, running, quota_deferred), and research_failed_at from its newest failed report.
-- 3) settings: research gains the visitor scan limits (defaults, stored values win) and tavily_daily_cap becomes 60.

-- ------------------------------------------------------------------------------------------------ 1) + 2) the public feed view
-- Guard: the view must still have exactly the 20261015008500 column list; if a later phase changed it, merge by hand.
do $$
declare
  v_expected text[] := array['scan_run_id','mode','rank','display_order','withheld','security_id','yahoo_symbol','name','exchange_code','exchange_name',
    'close','currency','session_date','threshold_line','lower_line_end','data_freshness','is_new_episode','since_date','operational_category',
    'category_reason','conclusion','bankruptcy_risk','summary','research_completed_at','report_id','eur_symbol_yahoo','ibkr_local_symbol',
    'ibkr_exchange_id','eur_status','eur_verified_at','research_provider','research_model','fallback_reason','wait_reason','last_attempt_at',
    'next_attempt_at','next_provider','country','evidence_trimmed','line3_end','line4_end','reached_line4','is_top10'];
  v_actual text[];
begin
  select array_agg(column_name::text order by ordinal_position) into v_actual
    from information_schema.columns where table_schema = 'public' and table_name = 'v_todays_discounts';
  if v_actual is distinct from v_expected and v_actual[1:array_length(v_expected, 1)] is distinct from v_expected then
    raise exception 'public.v_todays_discounts columns changed since 20261015008500 (%). Merge the listing and research columns into the current definition by hand.', v_actual;
  end if;
end $$;

-- The 20261015008500 definition, then listing_country, research_started_at, research_wait_reason, research_requested_by and
-- research_failed_at (in that order, last). todays_discounts_feed returns the view's row type, so it follows. security_invoker stays on.
create or replace view public.v_todays_discounts with (security_invoker = true) as
select t.scan_run_id, t.mode, t.rank, t.display_order, t.withheld, s.id as security_id, s.yahoo_symbol, c.name, ex.code as exchange_code, ex.name as exchange_name,
       t.close, t.currency, t.session_date, t.threshold_line, t.lower_line_end, t.data_freshness, t.is_new_episode, e.opened_session_date as since_date,
       t.operational_category, t.category_reason, t.conclusion, t.bankruptcy_risk, t.summary, t.research_completed_at, t.report_id,
       eq.eur_symbol_yahoo, eq.ibkr_local_symbol, eq.ibkr_exchange_id, eq.status::text as eur_status, eq.verified_at as eur_verified_at,
       rr.provider as research_provider, rr.model as research_model,
       rr.fallback_reason, rr.wait_reason, rr.last_attempt_at, rr.next_attempt_at, rr.next_provider,
       coalesce(c.country, ex.country) as country,
       rr.evidence_trimmed,
       coalesce((t.channel -> 'end' ->> 'lower1')::float8, case when t.threshold_line = '-3' then t.lower_line_end end) as line3_end,
       coalesce((t.channel -> 'end' ->> 'lower2')::float8, case when t.threshold_line = '-4' then t.lower_line_end end) as line4_end,
       coalesce(t.close <= (t.channel -> 'end' ->> 'lower2')::float8,
                t.threshold_line = '-4' and t.close <= t.lower_line_end, false) as reached_line4,
       (t.rank <= 10) as is_top10,
       ex.country as listing_country,
       inflight.started_at as research_started_at,
       inflight.wait_reason as research_wait_reason,
       inflight.usage ->> 'source' as research_requested_by,
       failed.failed_at as research_failed_at
  from todays_discounts t
  join securities s on s.id = t.security_id
  join companies c on c.id = t.company_id
  join exchanges ex on ex.code = s.exchange_code
  join signal_episodes e on e.id = t.episode_id
  left join lateral (
    select q.* from eur_equivalents q
     where q.security_id = t.security_id
     order by case q.status when 'verified' then 0 when 'unverified' then 1 else 2 end, (q.ibkr_exchange_id = 'IBIS') desc
     limit 1
  ) eq on true
  left join research_reports rr on rr.id = coalesce(t.research_report_id, t.report_id)
  left join lateral (
    select f.started_at, f.wait_reason, f.usage from research_reports f
     where f.security_id = t.security_id and f.status in ('queued', 'running', 'quota_deferred')
     order by f.created_at desc, f.id desc
     limit 1
  ) inflight on true
  left join lateral (
    select coalesce(f.completed_at, f.updated_at) as failed_at from research_reports f
     where f.security_id = t.security_id and f.status = 'failed'
     order by coalesce(f.completed_at, f.updated_at) desc, f.id desc
     limit 1
  ) failed on true
 where t.scan_run_id = (select id from scan_runs where results_published_at is not null order by scan_date_local desc limit 1);

revoke all on public.v_todays_discounts from anon, authenticated;
grant select on public.v_todays_discounts to anon, authenticated;

-- ------------------------------------------------------------------------------------------------ 1) the Company List
-- Same columns as 20261015008200 plus listing_country last (the return type changes, so drop and create; same grants). p_country now
-- matches the exchange's country, not coalesce(companies.country, exchanges.country).
drop function public.company_list(universe_mode, int, int, text);
create function public.company_list(p_mode universe_mode, p_limit int default 15, p_after_rank int default null, p_country text default null)
returns table (rank int, company_id uuid, security_id uuid, yahoo_symbol text, name text, currency text,
               last_close float8, prev_close float8, change_pct float8, session_date date, price_freshness freshness_status,
               market_cap_usd float8, market_cap_native float8, market_cap_ccy text,
               is_top10 boolean, applicable_line threshold_line, lower_line_positive boolean, is_discount boolean,
               state text, total_count bigint, country text, listing_country text)
language sql stable security definer set search_path = public as $$
  with run as (select id from scan_runs where list_published_at is not null order by scan_date_local desc limit 1),
  base as (
    select u.*, count(*) over () as total_count
      from universe_snapshots u
      join run on u.scan_run_id = run.id
      join securities s0 on s0.id = u.security_id
      join exchanges ex0 on ex0.code = s0.exchange_code
     where u.mode = p_mode and u.rank > coalesce(p_after_rank, 0)
       and (p_country is null or ex0.country = p_country)
     order by u.rank limit least(greatest(p_limit, 1), 100))
  select b.rank, b.company_id, b.security_id, s.yahoo_symbol, c.name, s.currency,
         ps.last_close, ps.prev_close,
         case when ps.prev_close > 0 then (ps.last_close / ps.prev_close - 1) * 100 end,
         ps.last_session_date, ps.freshness, b.market_cap_usd,
         mc.market_cap_native, mc.currency_major, b.is_top10, b.applicable_line, b.lower_line_positive, b.is_discount, b.state, b.total_count,
         coalesce(c.country, ex.country), ex.country
    from base b
    join securities s on s.id = b.security_id
    join companies c on c.id = b.company_id
    join exchanges ex on ex.code = s.exchange_code
    left join price_series ps on ps.security_id = b.security_id
    left join lateral (select m.market_cap_native, m.currency_major from market_cap_snapshots m
                        where m.security_id = b.security_id order by m.id desc limit 1) mc on true
   order by b.rank
$$;
revoke execute on function public.company_list(universe_mode, int, int, text) from public;
grant execute on function public.company_list(universe_mode, int, int, text) to anon, authenticated;
comment on function public.company_list(universe_mode, int, int, text) is
  'Public Company List. p_country filters on the exchange country (Listed in). country is the company''s home country (flags, identity line); listing_country is the exchange country of the canonical listing.';

-- ------------------------------------------------------------------------------------------------ 3) settings
update public.app_settings
   set value = '{"visitor_scans_per_hour_per_ip": 3, "visitor_scans_per_day": 8, "visitor_retry_minutes": 60}'::jsonb || value
 where key = 'research';

update public.app_settings
   set value = jsonb_set(value, '{tavily_daily_cap}', '60'::jsonb)
 where key = 'research';
