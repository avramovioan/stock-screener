-- Groq free tier as the research backup (owner decision 2026-10-16): the backup model gets a trimmed evidence set to fit its
-- 8,000 tokens per minute, so its reports are thinner. evidence_trimmed says so, and the cards word the backup note accordingly.
-- Forward-only and safe on top of existing rows: the column is nullable (null = not trimmed / unknown), no default, no rewrite.

alter table public.research_reports add column if not exists evidence_trimmed boolean;

comment on column public.research_reports.evidence_trimmed is 'True when the backup model wrote the report from a shorter evidence set (its request budget cut documents or evidence); null otherwise.';

-- The card research view (read by useCardResearch): the 20261015007900 definition, evidence_trimmed last.
create or replace view public.v_card_research with (security_invoker = true) as
select t.scan_run_id, t.mode, t.security_id, t.operational_category, t.category_reason, t.withheld,
       t.research_report_id, t.research_summary, t.conclusion, t.bankruptcy_risk, t.research_completed_at,
       r.status as report_status, r.error as report_error, r.step as report_step,
       r.provider, r.model, r.prompt_version,
       r.provider as research_provider, r.model as research_model,
       r.fallback_reason, r.wait_reason, r.last_attempt_at, r.next_attempt_at, r.next_provider,
       r.evidence_trimmed
  from public.todays_discounts t
  left join public.research_reports r on r.id = t.research_report_id;
grant select on public.v_card_research to anon, authenticated;

-- The public feed view: the 20261015008100 definition, evidence_trimmed last. todays_discounts_feed returns the view's row type,
-- so it follows the new column. The report is still read with the caller's rights (security_invoker): a holders-only report
-- never reaches anon.
create or replace view public.v_todays_discounts with (security_invoker = true) as
select t.scan_run_id, t.mode, t.rank, t.display_order, t.withheld, s.id as security_id, s.yahoo_symbol, c.name, ex.code as exchange_code, ex.name as exchange_name,
       t.close, t.currency, t.session_date, t.threshold_line, t.lower_line_end, t.data_freshness, t.is_new_episode, e.opened_session_date as since_date,
       t.operational_category, t.category_reason, t.conclusion, t.bankruptcy_risk, t.summary, t.research_completed_at, t.report_id,
       eq.eur_symbol_yahoo, eq.ibkr_local_symbol, eq.ibkr_exchange_id, eq.status::text as eur_status, eq.verified_at as eur_verified_at,
       rr.provider as research_provider, rr.model as research_model,
       rr.fallback_reason, rr.wait_reason, rr.last_attempt_at, rr.next_attempt_at, rr.next_provider,
       coalesce(c.country, ex.country) as country,
       rr.evidence_trimmed
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
