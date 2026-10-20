-- Digest candidates are the companies new on the list (owner decision 2026-10-19, spec 5.12).
-- Forward-only and replay-safe (drop-then-create of one function, grants re-stated). Nothing is rewritten.
--
-- notify_discount_candidates(p_scan_run, p_user, p_finished_only): a candidate is a todays_discounts row of the run whose
-- is_new_episode is true, or whose security_id has no row of the same mode in the previous published run (the newest earlier run with
-- results_published_at set), so a company that re-enters after leaving counts as new. With no previous run every row is new.
-- The green/amber, withheld and finished-research conditions are gone: research state is irrelevant, and the digest stage no longer
-- waits for research. p_finished_only stays for signature stability and is ignored.
-- Kept: the worldwide mode, the user's listing-country filter, the A-13 carry-over (no digest_items row yet) and the 20261015008500 tag inputs.
-- The research outcome columns (category, conclusion, bankruptcy_risk) are null unless a complete report exists; exchange_code is appended
-- last so the digest can show the home ticker. The return type changes, so drop and create; grants as in 20261015004000 (service role only).

drop function if exists public.notify_discount_candidates(uuid, uuid, boolean);
create function public.notify_discount_candidates(p_scan_run uuid, p_user uuid, p_finished_only boolean)
returns table (episode_id uuid, company_id uuid, security_id uuid, mode universe_mode, rank int, yahoo_symbol text,
  name text, close float8, currency text, session_date date, threshold_line text, category text, conclusion text,
  bankruptcy_risk text, summary text, eur_symbol text, eur_status text, is_top10 boolean, reached_line4 boolean, exchange_code text)
language sql stable security definer set search_path = public as $$
  with prev as (
    select r.id
      from scan_runs r
      join scan_runs cur on cur.id = p_scan_run
     where r.results_published_at is not null and r.id <> cur.id and r.scan_date_local < cur.scan_date_local
     order by r.scan_date_local desc
     limit 1
  )
  select t.episode_id, t.company_id, t.security_id, t.mode, t.rank, s.yahoo_symbol, c.name, t.close, t.currency,
         t.session_date, t.threshold_line::text,
         case when done.ok then t.operational_category::text end,
         case when done.ok then t.conclusion end,
         case when done.ok then t.bankruptcy_risk::text end,
         case when done.ok then coalesce(t.research_summary, t.summary, '') else '' end,
         eq.eur_symbol_yahoo, eq.status::text,
         (t.rank <= 10),
         coalesce(t.close <= (t.channel -> 'end' ->> 'lower2')::float8, t.threshold_line = '-4' and t.close <= t.lower_line_end, false),
         s.exchange_code
    from todays_discounts t
    join securities s on s.id = t.security_id
    join exchanges ex on ex.code = s.exchange_code
    join companies c on c.id = t.company_id
    join notification_preferences p on p.user_id = p_user
    cross join lateral (
      select (coalesce(t.research_report_id, t.report_id) is not null and t.research_completed_at is not null) as ok
    ) done
    left join lateral (
      select q.eur_symbol_yahoo, q.status from eur_equivalents q
       where q.security_id = t.security_id
       order by case q.status when 'verified' then 0 when 'unverified' then 1 else 2 end, (q.ibkr_exchange_id = 'IBIS') desc
       limit 1
    ) eq on true
   where t.scan_run_id = p_scan_run
     and t.mode = 'worldwide'
     and (p.digest_country_filter is null or p.digest_country_filter = coalesce(c.country, ex.country))
     and (t.is_new_episode
          or not exists (select 1 from prev join todays_discounts o on o.scan_run_id = prev.id
                          where o.mode = t.mode and o.security_id = t.security_id))
     and not exists (select 1 from digest_items i where i.user_id = p_user and i.ref_type = 'episode' and i.ref_id = t.episode_id)
   order by t.mode, t.rank, s.yahoo_symbol;
$$;
revoke all on function public.notify_discount_candidates(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.notify_discount_candidates(uuid, uuid, boolean) to service_role;
