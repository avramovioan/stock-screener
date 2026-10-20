-- Owner decisions 2026-10-16: one worldwide ranking, the US is a display filter, the country is shown on every public row.
-- country = the company's country (Yahoo assetProfile, headquarters), the exchange's country when that is null.

-- 1. The public feed view: the 20261015007900 definition, country last. todays_discounts_feed returns the view's row type.
create or replace view public.v_todays_discounts with (security_invoker = true) as
select t.scan_run_id, t.mode, t.rank, t.display_order, t.withheld, s.id as security_id, s.yahoo_symbol, c.name, ex.code as exchange_code, ex.name as exchange_name,
       t.close, t.currency, t.session_date, t.threshold_line, t.lower_line_end, t.data_freshness, t.is_new_episode, e.opened_session_date as since_date,
       t.operational_category, t.category_reason, t.conclusion, t.bankruptcy_risk, t.summary, t.research_completed_at, t.report_id,
       eq.eur_symbol_yahoo, eq.ibkr_local_symbol, eq.ibkr_exchange_id, eq.status::text as eur_status, eq.verified_at as eur_verified_at,
       rr.provider as research_provider, rr.model as research_model,
       rr.fallback_reason, rr.wait_reason, rr.last_attempt_at, rr.next_attempt_at, rr.next_provider,
       coalesce(c.country, ex.country) as country
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
 where t.scan_run_id = (select id from scan_runs where results_published_at is not null order by scan_date_local desc limit 1);

grant select on public.v_todays_discounts to anon, authenticated;

-- 2. The Company List: the same columns, country last (the return type changes, so drop and create; grants as in 20261015001200).
drop function public.company_list(universe_mode, int, int);
create function public.company_list(p_mode universe_mode, p_limit int default 15, p_after_rank int default null)
returns table (rank int, company_id uuid, security_id uuid, yahoo_symbol text, name text, currency text,
               last_close float8, prev_close float8, change_pct float8, session_date date, price_freshness freshness_status,
               market_cap_usd float8, market_cap_native float8, market_cap_ccy text,
               is_top10 boolean, applicable_line threshold_line, lower_line_positive boolean, is_discount boolean,
               state text, total_count bigint, country text)
language sql stable security definer set search_path = public as $$
  with run as (select id from scan_runs where list_published_at is not null order by scan_date_local desc limit 1),
  base as (
    select u.*, count(*) over () as total_count
      from universe_snapshots u join run on u.scan_run_id = run.id
     where u.mode = p_mode and u.rank > coalesce(p_after_rank, 0)
     order by u.rank limit least(greatest(p_limit, 1), 100))
  select b.rank, b.company_id, b.security_id, s.yahoo_symbol, c.name, s.currency,
         ps.last_close, ps.prev_close,
         case when ps.prev_close > 0 then (ps.last_close / ps.prev_close - 1) * 100 end,
         ps.last_session_date, ps.freshness, b.market_cap_usd,
         mc.market_cap_native, mc.currency_major, b.is_top10, b.applicable_line, b.lower_line_positive, b.is_discount, b.state, b.total_count,
         coalesce(c.country, ex.country)
    from base b
    join securities s on s.id = b.security_id
    join companies c on c.id = b.company_id
    join exchanges ex on ex.code = s.exchange_code
    left join price_series ps on ps.security_id = b.security_id
    left join lateral (select m.market_cap_native, m.currency_major from market_cap_snapshots m
                        where m.security_id = b.security_id order by m.id desc limit 1) mc on true
   order by b.rank
$$;
revoke execute on function public.company_list(universe_mode, int, int) from public;
grant execute on function public.company_list(universe_mode, int, int) to anon, authenticated;

-- 3. Digest candidates: `worldwide` entries only (digest_modes is no longer read), narrowed by the user's digest_country_filter
-- (null = all countries). Same signature and columns as 20261015006000; grants are kept by create or replace.
create or replace function public.notify_discount_candidates(p_scan_run uuid, p_user uuid, p_finished_only boolean)
returns table (episode_id uuid, company_id uuid, security_id uuid, mode universe_mode, rank int, yahoo_symbol text,
  name text, close float8, currency text, session_date date, threshold_line text, category text, conclusion text,
  bankruptcy_risk text, summary text, eur_symbol text, eur_status text)
language sql stable security definer set search_path = public as $$
  select t.episode_id, t.company_id, t.security_id, t.mode, t.rank, s.yahoo_symbol, c.name, t.close, t.currency,
         t.session_date, t.threshold_line::text, t.operational_category::text, t.conclusion, t.bankruptcy_risk::text,
         coalesce(t.research_summary, t.summary, ''), eq.eur_symbol_yahoo, eq.status::text
    from todays_discounts t
    join securities s on s.id = t.security_id
    join exchanges ex on ex.code = s.exchange_code
    join companies c on c.id = t.company_id
    join notification_preferences p on p.user_id = p_user
    left join lateral (
      select q.eur_symbol_yahoo, q.status from eur_equivalents q
       where q.security_id = t.security_id
       order by case q.status when 'verified' then 0 when 'unverified' then 1 else 2 end, (q.ibkr_exchange_id = 'IBIS') desc
       limit 1
    ) eq on true
   where t.scan_run_id = p_scan_run
     and t.mode = 'worldwide'
     and (p.digest_country_filter is null or p.digest_country_filter = coalesce(c.country, ex.country))
     and t.operational_category in ('green', 'amber')
     and not t.withheld
     and (not p_finished_only or (coalesce(t.research_report_id, t.report_id) is not null and t.research_completed_at is not null))
     and not exists (select 1 from digest_items i where i.user_id = p_user and i.ref_type = 'episode' and i.ref_id = t.episode_id)
   order by t.mode, t.rank, s.yahoo_symbol;
$$;

-- 4. The skip-scan check considers every enabled exchange: the ranking is worldwide, so Asian Monday closes trigger a Monday scan and
-- Sunday is the weekly no-op. (Replaces the 'us' default of 20261015008000; any other stored value is untouched.)
update public.app_settings
   set value = jsonb_set(value, '{session_scope}', '"all"')
 where key = 'scan_cadence' and value ->> 'session_scope' = 'us';
