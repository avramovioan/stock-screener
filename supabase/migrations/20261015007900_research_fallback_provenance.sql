-- Research provenance and wait reasons (owner request 2026-10-16, mockup v5): the cards show who wrote a report, why the backup
-- model did, and why a pending report waits and when it is tried next.
-- Forward-only and safe on top of existing rows: every new column is nullable, so existing reports keep a null fallback_reason
-- and wait fields, and their provider / model stay as stored. `provider` and `model` (already there) now hold the WRITER of the
-- report text (for example gemini / gemini-3.5-flash, or mistral / mistral-large-latest after a hand-over), not just the primary.

alter table public.research_reports add column if not exists fallback_reason text;
alter table public.research_reports add column if not exists wait_reason text;
alter table public.research_reports add column if not exists last_attempt_at timestamptz;
alter table public.research_reports add column if not exists next_attempt_at timestamptz;
alter table public.research_reports add column if not exists next_provider text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'research_reports_fallback_reason_check' and conrelid = 'public.research_reports'::regclass) then
    alter table public.research_reports add constraint research_reports_fallback_reason_check
      check (fallback_reason is null or fallback_reason in ('primary_unavailable', 'primary_quota', 'primary_rate_limited'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'research_reports_wait_reason_check' and conrelid = 'public.research_reports'::regclass) then
    alter table public.research_reports add constraint research_reports_wait_reason_check
      check (wait_reason is null or wait_reason in ('provider_unavailable', 'llm_quota', 'search_quota', 'rate_limited', 'weekend', 'cadence_72h'));
  end if;
end $$;

comment on column public.research_reports.fallback_reason is 'Why the backup model wrote this report (primary_unavailable | primary_quota | primary_rate_limited); null when the primary did.';
comment on column public.research_reports.wait_reason is 'Why the report waits (provider_unavailable | llm_quota | search_quota | rate_limited | weekend | cadence_72h); null when nothing waits. Cleared on completion.';
comment on column public.research_reports.last_attempt_at is 'While waiting: when the last try happened (for weekend and cadence_72h waits: the last AI activity of the security).';
comment on column public.research_reports.next_attempt_at is 'While waiting: when the next try is due (the not_before of the job that will run it).';
comment on column public.research_reports.next_provider is 'While waiting: the model id the next try will use (the web app derives the display name).';

-- The card research view (read by useCardResearch): the same eight fields as the feed, raw ids. `provider` / `model` stay for
-- the report page. New columns go last: create or replace view keeps the existing column list.
create or replace view public.v_card_research with (security_invoker = true) as
select t.scan_run_id, t.mode, t.security_id, t.operational_category, t.category_reason, t.withheld,
       t.research_report_id, t.research_summary, t.conclusion, t.bankruptcy_risk, t.research_completed_at,
       r.status as report_status, r.error as report_error, r.step as report_step,
       r.provider, r.model, r.prompt_version,
       r.provider as research_provider, r.model as research_model,
       r.fallback_reason, r.wait_reason, r.last_attempt_at, r.next_attempt_at, r.next_provider
  from public.todays_discounts t
  left join public.research_reports r on r.id = t.research_report_id;
grant select on public.v_card_research to anon, authenticated;

-- The public feed: the same fields, joined on the card's linked report (research_completed_at is already a column of the view).
-- The report is read with the caller's rights (security_invoker): a holders-only report never reaches anon, and a card is
-- never linked to one anyway. The feed function returns the view's row type, so it follows the new columns.
create or replace view public.v_todays_discounts with (security_invoker = true) as
select t.scan_run_id, t.mode, t.rank, t.display_order, t.withheld, s.id as security_id, s.yahoo_symbol, c.name, ex.code as exchange_code, ex.name as exchange_name,
       t.close, t.currency, t.session_date, t.threshold_line, t.lower_line_end, t.data_freshness, t.is_new_episode, e.opened_session_date as since_date,
       t.operational_category, t.category_reason, t.conclusion, t.bankruptcy_risk, t.summary, t.research_completed_at, t.report_id,
       eq.eur_symbol_yahoo, eq.ibkr_local_symbol, eq.ibkr_exchange_id, eq.status::text as eur_status, eq.verified_at as eur_verified_at,
       rr.provider as research_provider, rr.model as research_model,
       rr.fallback_reason, rr.wait_reason, rr.last_attempt_at, rr.next_attempt_at, rr.next_provider
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
