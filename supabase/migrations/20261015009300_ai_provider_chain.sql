-- AI provider chain (owner decisions 2026-10-20): an ordered chain of models, a per-model daily quota state, a public quota status,
-- and a one-time reset of unfinished research.
-- Forward-only and replay-safe (create or replace, if not exists, on conflict). Stored settings values win on a replay. The one-time
-- reset only touches reports still queued, running or quota_deferred, so a replay changes nothing new; complete reports are never
-- touched.
--
-- 1) settings: research.llm_chain (gemini 3.5 flash, gemini 3.5 flash lite, groq gpt-oss-120b and 20b) and
--    research.busy_retry_minutes = 15. API keys stay in the existing secrets.
-- 2) public.llm_model_state: when a model is out of quota for the day (service role only; RLS on, no anon or authenticated access).
-- 3) public.research_quota_status(): { available, next_reset_at } for the visitor "Scan with AI" button and the research-request
--    function; it exposes nothing else.
-- 4) feed: research_failed_reason (the newest failed report's error, last column); the failed lateral ignores reset and superseded
--    reports; the in-flight lateral ignores reports that started before the newest complete report finished.
-- 5) one-time reset: every queued, running or quota_deferred report becomes failed with error = 'reset' and its open research jobs
--    are deleted. research_reports.error is plain text (no check constraint), so no_quota, providers_busy, reset and superseded
--    need no schema change.

-- ------------------------------------------------------------------------------------------------ 1) settings
update public.app_settings
   set value = jsonb_build_object(
         'busy_retry_minutes', 15,
         'llm_chain', jsonb_build_array(
           jsonb_build_object('key', 'gemini:gemini-3.5-flash', 'provider', 'gemini', 'label', 'gemini', 'model', 'gemini-3.5-flash',
                              'max_input_tokens', null, 'max_output_tokens', null, 'reasoning_effort', null, 'quota_reset', 'pacific'),
           jsonb_build_object('key', 'gemini:gemini-3.5-flash-lite', 'provider', 'gemini', 'label', 'gemini', 'model', 'gemini-3.5-flash-lite',
                              'max_input_tokens', null, 'max_output_tokens', null, 'reasoning_effort', null, 'quota_reset', 'pacific'),
           jsonb_build_object('key', 'groq:openai/gpt-oss-120b', 'provider', 'openai_compatible', 'label', 'groq', 'model', 'openai/gpt-oss-120b',
                              'base_url', 'https://api.groq.com/openai/v1', 'max_input_tokens', 4500, 'max_output_tokens', 3000,
                              'reasoning_effort', 'low', 'quota_reset', 'utc'),
           jsonb_build_object('key', 'groq:openai/gpt-oss-20b', 'provider', 'openai_compatible', 'label', 'groq', 'model', 'openai/gpt-oss-20b',
                              'base_url', 'https://api.groq.com/openai/v1', 'max_input_tokens', 4500, 'max_output_tokens', 3000,
                              'reasoning_effort', 'low', 'quota_reset', 'utc'))) || value
 where key = 'research';

-- ------------------------------------------------------------------------------------------------ 2) model state
create table if not exists public.llm_model_state (
  model_key text primary key,
  exhausted_until timestamptz,
  last_error text,
  updated_at timestamptz not null default now()
);
alter table public.llm_model_state enable row level security;
revoke all on public.llm_model_state from public, anon, authenticated;
grant all on public.llm_model_state to service_role;
comment on table public.llm_model_state is 'Per chain model: exhausted_until is set when the model answers a per-day quota error. Service role only.';

-- ------------------------------------------------------------------------------------------------ 3) quota status
-- available is false when every chain model is exhausted (quota state, or the day's request ledger at research.llm_daily_request_cap), or the day's Tavily credits are below 8, or the visitor daily cap is used up.
-- next_reset_at is the earliest time any of the active blockers clears (null when available).
create or replace function public.research_quota_status() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_settings jsonb;
  v_keys text[];
  v_models_out boolean := false;
  v_models_clear timestamptz;
  v_req_cap int;
  v_today date := (now() at time zone 'utc')::date;
  v_midnight timestamptz := ((now() at time zone 'utc')::date + 1)::timestamp at time zone 'utc';
  v_tavily_cap int; v_tavily_used int;
  v_visitor_cap int; v_visitor_used int;
  v_clears timestamptz[] := '{}';
begin
  select value into v_settings from app_settings where key = 'research';
  select coalesce(array_agg(e ->> 'key'), '{}') into v_keys
    from jsonb_array_elements(case when jsonb_typeof(v_settings -> 'llm_chain') = 'array' then v_settings -> 'llm_chain' else '[]'::jsonb end) e;
  v_req_cap := coalesce((v_settings ->> 'llm_daily_request_cap')::int, 300);
  if coalesce(array_length(v_keys, 1), 0) > 0 then
    -- a model is out when its per-day quota state is active, or today's llm_requests in the request ledger reached the cap
    select count(*) filter (where k.until is not null) = array_length(v_keys, 1), min(k.until)
      into v_models_out, v_models_clear
      from (
        select key,
               case when s.exhausted_until > now() or coalesce(u.used, 0) >= v_req_cap
                    then greatest(case when s.exhausted_until > now() then s.exhausted_until end,
                                  case when coalesce(u.used, 0) >= v_req_cap then v_midnight end)
               end as until
          from unnest(v_keys) key
          left join llm_model_state s on s.model_key = key
          left join ai_quota_usage u on u.provider = key and u.resource = 'llm_requests' and u.period_kind = 'day' and u.period_start = v_today
      ) k;
    if v_models_out then v_clears := v_clears || v_models_clear; end if;
  end if;

  v_tavily_cap := coalesce((v_settings ->> 'tavily_daily_cap')::int, 32);
  select coalesce(sum(used), 0) into v_tavily_used from ai_quota_usage
   where provider = 'tavily' and resource = 'credits' and period_kind = 'day' and period_start = v_today;
  if v_tavily_cap - v_tavily_used < 8 then v_clears := v_clears || v_midnight; end if;

  v_visitor_cap := coalesce((v_settings ->> 'visitor_scans_per_day')::int, 8);
  select coalesce(sum(used), 0) into v_visitor_used from ai_quota_usage
   where provider = 'visitor' and resource = 'scans' and period_kind = 'day' and period_start = v_today;
  if v_visitor_used >= v_visitor_cap then v_clears := v_clears || v_midnight; end if;

  if coalesce(array_length(v_clears, 1), 0) = 0 then
    return jsonb_build_object('available', true, 'next_reset_at', null);
  end if;
  return jsonb_build_object('available', false, 'next_reset_at', (select min(c) from unnest(v_clears) c));
end $$;
revoke all on function public.research_quota_status() from public;
grant execute on function public.research_quota_status() to anon, authenticated, service_role;
comment on function public.research_quota_status() is 'Public: { available, next_reset_at } for the Scan with AI button. Exposes nothing else.';

-- ------------------------------------------------------------------------------------------------ 4) the public feed view
-- Guard: the view must still have exactly the 20261015008800 column list; if a later phase changed it, merge by hand.
do $$
declare
  v_expected text[] := array['scan_run_id','mode','rank','display_order','withheld','security_id','yahoo_symbol','name','exchange_code','exchange_name',
    'close','currency','session_date','threshold_line','lower_line_end','data_freshness','is_new_episode','since_date','operational_category',
    'category_reason','conclusion','bankruptcy_risk','summary','research_completed_at','report_id','eur_symbol_yahoo','ibkr_local_symbol',
    'ibkr_exchange_id','eur_status','eur_verified_at','research_provider','research_model','fallback_reason','wait_reason','last_attempt_at',
    'next_attempt_at','next_provider','country','evidence_trimmed','line3_end','line4_end','reached_line4','is_top10',
    'listing_country','research_started_at','research_wait_reason','research_requested_by','research_failed_at'];
  v_actual text[];
begin
  select array_agg(column_name::text order by ordinal_position) into v_actual
    from information_schema.columns where table_schema = 'public' and table_name = 'v_todays_discounts';
  if v_actual is distinct from v_expected and v_actual[1:array_length(v_expected, 1)] is distinct from v_expected then
    raise exception 'public.v_todays_discounts columns changed since 20261015008800 (%). Merge research_failed_reason into the current definition by hand.', v_actual;
  end if;
end $$;

-- The 20261015008800 definition plus research_failed_reason last. todays_discounts_feed returns the view's row type, so it follows.
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
       failed.failed_at as research_failed_at,
       failed.error as research_failed_reason
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
       and coalesce(f.started_at, f.created_at) >= coalesce(
             (select max(k.completed_at) from research_reports k where k.security_id = t.security_id and k.status = 'complete'),
             '-infinity'::timestamptz)
     order by f.created_at desc, f.id desc
     limit 1
  ) inflight on true
  left join lateral (
    select coalesce(f.completed_at, f.updated_at) as failed_at, f.error from research_reports f
     where f.security_id = t.security_id and f.status = 'failed' and coalesce(f.error, '') not in ('reset', 'superseded')
     order by coalesce(f.completed_at, f.updated_at) desc, f.id desc
     limit 1
  ) failed on true
 where t.scan_run_id = (select id from scan_runs where results_published_at is not null order by scan_date_local desc limit 1);

revoke all on public.v_todays_discounts from anon, authenticated;
grant select on public.v_todays_discounts to anon, authenticated;

-- ------------------------------------------------------------------------------------------------ 5) one-time reset
with reset as (
  update public.research_reports
     set status = 'failed', error = 'reset', completed_at = now()
   where status in ('queued', 'running', 'quota_deferred')
  returning id, security_id
)
delete from public.scan_jobs j
 using reset r
 where j.stage = 'research' and j.status in ('queued', 'leased', 'failed')
   and (j.payload ->> 'report_id' = r.id::text or j.payload ->> 'security_id' = r.security_id::text);
