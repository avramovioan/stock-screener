-- Every rank triggers on the -3 line (owner decision 2026-10-16, A-51). A discount card is any close at or below the -3 line;
-- the worldwide rank decides only the tag ("Strong buy" for the top 10, otherwise whether the -4 line is already reached).
-- Forward-only and safe on top of existing rows: no data is rewritten. Active '-4' episodes (opened before this change) stay valid and
-- are continued on the -3 line by the next scan (threshold_changed + silent continuation). Existing universe_snapshots rows keep the
-- applicable_line they were written with; from this scan on it is '-3' for every rank ("the line that decides the trigger").
--
-- Both line ends are read from data every card already stores: todays_discounts.channel is the channel at decision time, and its
-- end.lower1 / end.lower2 are the -3 and -4 line values at the latest bar. Nothing new is persisted.

-- 1. The public feed view: the 20261015008300 definition, then line3_end, line4_end, reached_line4 and is_top10 (in that order, last).
-- todays_discounts_feed returns the view's row type, so it follows the new columns. security_invoker stays on: the report join is
-- still read with the caller's rights.
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
       (t.rank <= 10) as is_top10
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

revoke all on public.v_todays_discounts from anon, authenticated;
grant select on public.v_todays_discounts to anon, authenticated;

-- 2. Digest candidates carry the tag inputs: is_top10 and reached_line4 are appended last. The return type changes, so drop and create
-- (grants as in 20261015004000: service role only). Every -3 discount that passed research is a candidate; rank is not a filter.
drop function public.notify_discount_candidates(uuid, uuid, boolean);
create function public.notify_discount_candidates(p_scan_run uuid, p_user uuid, p_finished_only boolean)
returns table (episode_id uuid, company_id uuid, security_id uuid, mode universe_mode, rank int, yahoo_symbol text,
  name text, close float8, currency text, session_date date, threshold_line text, category text, conclusion text,
  bankruptcy_risk text, summary text, eur_symbol text, eur_status text, is_top10 boolean, reached_line4 boolean)
language sql stable security definer set search_path = public as $$
  select t.episode_id, t.company_id, t.security_id, t.mode, t.rank, s.yahoo_symbol, c.name, t.close, t.currency,
         t.session_date, t.threshold_line::text, t.operational_category::text, t.conclusion, t.bankruptcy_risk::text,
         coalesce(t.research_summary, t.summary, ''), eq.eur_symbol_yahoo, eq.status::text,
         (t.rank <= 10),
         coalesce(t.close <= (t.channel -> 'end' ->> 'lower2')::float8, t.threshold_line = '-4' and t.close <= t.lower_line_end, false)
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
revoke all on function public.notify_discount_candidates(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.notify_discount_candidates(uuid, uuid, boolean) to service_role;

comment on column public.universe_snapshots.applicable_line is
  'The line that decides the discount trigger. ''-3'' for every rank since A-51 (it was ''-3'' for the top 10 and ''-4'' for the rest before); rank decides only the tag.';
