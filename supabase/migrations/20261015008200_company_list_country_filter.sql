-- Owner decision 2026-10-16: the Overview "Companies from" filter is applied by the database for The Company List, so the web
-- never fetches several pages to find 15 matching rows. p_country is optional; null keeps the unfiltered list. The match is the
-- same coalesce(companies.country, exchanges.country) the country column shows. total_count counts the filtered rows after the
-- cursor and the cursor stays the rank, so "Load more" works unchanged. Same columns and grants as 20261015008100.
drop function public.company_list(universe_mode, int, int);
create function public.company_list(p_mode universe_mode, p_limit int default 15, p_after_rank int default null, p_country text default null)
returns table (rank int, company_id uuid, security_id uuid, yahoo_symbol text, name text, currency text,
               last_close float8, prev_close float8, change_pct float8, session_date date, price_freshness freshness_status,
               market_cap_usd float8, market_cap_native float8, market_cap_ccy text,
               is_top10 boolean, applicable_line threshold_line, lower_line_positive boolean, is_discount boolean,
               state text, total_count bigint, country text)
language sql stable security definer set search_path = public as $$
  with run as (select id from scan_runs where list_published_at is not null order by scan_date_local desc limit 1),
  base as (
    select u.*, count(*) over () as total_count
      from universe_snapshots u
      join run on u.scan_run_id = run.id
      join securities s0 on s0.id = u.security_id
      join companies c0 on c0.id = u.company_id
      join exchanges ex0 on ex0.code = s0.exchange_code
     where u.mode = p_mode and u.rank > coalesce(p_after_rank, 0)
       and (p_country is null or coalesce(c0.country, ex0.country) = p_country)
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
revoke execute on function public.company_list(universe_mode, int, int, text) from public;
grant execute on function public.company_list(universe_mode, int, int, text) to anon, authenticated;
