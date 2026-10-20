-- P2 research schema (spec 6.3.5, 6.6.5, 6.9, 9.8, 9.12). Forward-only; every object is guarded so a replay is safe.
create schema if not exists app;

do $$
begin
  if not exists (select 1 from pg_type where typnamespace = 'public'::regnamespace and typname = 'research_status') then
    create type public.research_status as enum ('queued', 'running', 'complete', 'failed', 'quota_deferred', 'stale');
  end if;
  if not exists (select 1 from pg_type where typnamespace = 'public'::regnamespace and typname = 'research_kind') then
    create type public.research_kind as enum ('full', 'change_check');
  end if;
  if not exists (select 1 from pg_type where typnamespace = 'public'::regnamespace and typname = 'research_trigger') then
    create type public.research_trigger as enum ('new_discount', 'premium', 'monitor_first', 'monitor_change', 'refresh', 'manual');
  end if;
  if not exists (select 1 from pg_type where typnamespace = 'public'::regnamespace and typname = 'report_visibility') then
    create type public.report_visibility as enum ('public', 'holders');
  end if;
  if not exists (select 1 from pg_type where typnamespace = 'public'::regnamespace and typname = 'bankruptcy_risk') then
    create type public.bankruptcy_risk as enum ('Low', 'Moderate', 'High', 'Unclear');
  end if;
  if not exists (select 1 from pg_type where typnamespace = 'public'::regnamespace and typname = 'operational_category') then
    create type public.operational_category as enum ('green', 'amber', 'red', 'grey', 'pending');
  end if;
end $$;

create or replace function app.touch_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create table if not exists public.research_reports (
  id uuid primary key default gen_random_uuid(),
  security_id uuid not null references public.securities (id),
  company_id uuid not null references public.companies (id),
  scan_run_id uuid references public.scan_runs (id),
  kind public.research_kind not null default 'full',
  trigger public.research_trigger not null,
  status public.research_status not null default 'queued',
  step text,
  not_before timestamptz,
  is_current boolean not null default false,
  visibility public.report_visibility not null default 'public',
  report_md text,
  summary text,
  news_summary text,
  conclusion text check (conclusion in ('Meets these two fundamental checks.', 'Does not meet one or both checks.', 'Insufficient evidence to decide.')),
  bankruptcy_risk public.bankruptcy_risk,
  material_damage_established boolean,
  sufficient_evidence boolean,
  cited_evidence_ids int[] not null default '{}',
  claims jsonb not null default '[]',
  missing_documents jsonb not null default '[]',
  limitations jsonb not null default '[]',
  research_cutoff_date date,
  started_at timestamptz,
  completed_at timestamptz,
  provider text,
  model text,
  prompt_version text,
  schema_version text,
  usage jsonb not null default '{}',
  queries_used int not null default 0,
  docs_fetched int not null default 0,
  error text,
  supersedes_id uuid references public.research_reports (id),
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists research_one_current on public.research_reports (security_id) where is_current;
create index if not exists research_reports_security_idx on public.research_reports (security_id, created_at desc);
create index if not exists research_reports_deferred_idx on public.research_reports (status, not_before) where status = 'quota_deferred';
drop trigger if exists research_reports_touch on public.research_reports;
create trigger research_reports_touch before update on public.research_reports
  for each row execute function app.touch_updated_at();

create table if not exists public.research_sources (
  id bigint generated always as identity primary key,
  report_id uuid not null references public.research_reports (id) on delete cascade,
  evidence_id int not null,
  url text not null,
  canonical_url text not null,
  title text,
  publisher text,
  kind text not null check (kind in ('edgar_filing', 'ir_page', 'rss', 'yahoo_news', 'search_result', 'other')),
  published_at timestamptz,
  filing_date date,
  retrieved_at timestamptz,
  http_status int,
  content_type text,
  content_hash text,
  excerpt text check (excerpt is null or char_length(excerpt) <= 2000),
  extracted jsonb not null default '[]',
  liveness_verified_at timestamptz,
  verification text not null default 'pending' check (verification in ('pending', 'ok', 'failed', 'skipped')),
  used_in_report boolean not null default false,
  meta jsonb not null default '{}',
  unique (report_id, evidence_id),
  unique (report_id, canonical_url)
);

-- Transient: fetched text carried from fetch:n to extract:n. Deleted when a report completes or fails.
create table if not exists public.research_work_texts (
  report_id uuid not null references public.research_reports (id) on delete cascade,
  evidence_id int not null,
  text text not null check (char_length(text) <= 60000),
  created_at timestamptz not null default now(),
  primary key (report_id, evidence_id)
);

create table if not exists public.ai_quota_usage (
  id bigint generated always as identity primary key,
  provider text not null,
  resource text not null,
  period_kind text not null check (period_kind in ('day', 'month')),
  period_start date not null,
  used int not null default 0,
  limit_value int,
  unique (provider, resource, period_kind, period_start)
);

create table if not exists public.risk_monitor_state (
  user_id uuid not null references auth.users (id) on delete cascade,
  security_id uuid not null references public.securities (id),
  reasons text[] not null,
  first_monitored_at timestamptz not null default now(),
  last_check_at timestamptz,
  last_report_id uuid references public.research_reports (id),
  last_category public.operational_category,
  last_seen_items jsonb not null default '{}',
  next_due_at timestamptz,
  status text not null default 'active' check (status in ('active', 'paused')),
  primary key (user_id, security_id)
);
create index if not exists risk_monitor_state_security_idx on public.risk_monitor_state (security_id);
create index if not exists risk_monitor_state_due_idx on public.risk_monitor_state (next_due_at) where status = 'active';

create table if not exists public.risk_findings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  security_id uuid not null references public.securities (id),
  report_id uuid references public.research_reports (id),
  fingerprint text not null,
  category text not null check (category in ('liquidity_debt', 'guidance', 'accounting_audit', 'regulatory_legal', 'credit_rating', 'governance', 'other')),
  severity text not null check (severity in ('material', 'watch')),
  summary text not null,
  evidence jsonb not null default '[]',
  detected_at timestamptz not null default now(),
  resolved_at timestamptz,
  notified_at timestamptz,
  unique (user_id, security_id, fingerprint)
);
create index if not exists risk_findings_open_idx on public.risk_findings (user_id, security_id) where resolved_at is null;

-- Cards link to their report as soon as the report row exists (status drives the "pending/deferred" labels).
alter table public.todays_discounts add column if not exists research_report_id uuid references public.research_reports (id);
alter table public.todays_discounts add column if not exists research_summary text;
alter table public.todays_discounts add column if not exists conclusion text;
alter table public.todays_discounts add column if not exists bankruptcy_risk public.bankruptcy_risk;
alter table public.todays_discounts add column if not exists research_completed_at timestamptz;
create index if not exists todays_discounts_report_idx on public.todays_discounts (research_report_id);

-- Holder test used by RLS. P5 replaces the body with a broker_positions lookup (create or replace).
create or replace function app.holder(p_security_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.risk_monitor_state m
     where m.security_id = p_security_id and m.user_id = auth.uid()
  )
$$;

-- Atomic quota consumption (spec 9.8): one UPDATE with the cap in the WHERE clause is the lock and the check.
create or replace function app.consume_quota(p_provider text, p_resource text, p_amount int, p_period_kind text, p_limit int)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_start date;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'consume_quota: amount must be positive';
  end if;
  if p_period_kind not in ('day', 'month') then
    raise exception 'consume_quota: unknown period kind %', p_period_kind;
  end if;
  v_start := case p_period_kind
    when 'day' then (now() at time zone 'utc')::date
    else date_trunc('month', now() at time zone 'utc')::date
  end;
  insert into ai_quota_usage (provider, resource, period_kind, period_start, used, limit_value)
  values (p_provider, p_resource, p_period_kind, v_start, 0, p_limit)
  on conflict (provider, resource, period_kind, period_start) do nothing;
  update ai_quota_usage
     set used = used + p_amount, limit_value = p_limit
   where provider = p_provider and resource = p_resource
     and period_kind = p_period_kind and period_start = v_start
     and used + p_amount <= p_limit;
  return found;
end $$;

-- Makes a complete report the single current one for its security and records the one it supersedes.
create or replace function app.promote_research_report(p_report_id uuid) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_security uuid;
  v_status public.research_status;
  v_prev uuid;
begin
  select security_id, status into v_security, v_status from research_reports where id = p_report_id for update;
  if not found then
    raise exception 'promote_research_report: report % not found', p_report_id;
  end if;
  if v_status <> 'complete' then
    raise exception 'promote_research_report: only a complete report can become current';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_security::text, 0));
  select id into v_prev from research_reports
   where security_id = v_security and is_current and id <> p_report_id;
  update research_reports set is_current = false where security_id = v_security and is_current and id <> p_report_id;
  update research_reports set is_current = true, supersedes_id = coalesce(v_prev, supersedes_id) where id = p_report_id;
  return v_prev;
end $$;

create or replace function public.consume_quota_rpc(p_provider text, p_resource text, p_amount int, p_period_kind text, p_limit int)
returns boolean language sql security definer set search_path = public, pg_temp as $$
  select app.consume_quota(p_provider, p_resource, p_amount, p_period_kind, p_limit)
$$;

create or replace function public.promote_research_report_rpc(p_report_id uuid) returns uuid
language sql security definer set search_path = public, pg_temp as $$
  select app.promote_research_report(p_report_id)
$$;

grant usage on schema app to service_role;
revoke all on function app.consume_quota(text, text, int, text, int) from public, anon, authenticated;
revoke all on function app.promote_research_report(uuid) from public, anon, authenticated;
revoke all on function public.consume_quota_rpc(text, text, int, text, int) from public, anon, authenticated;
revoke all on function public.promote_research_report_rpc(uuid) from public, anon, authenticated;
grant execute on function app.consume_quota(text, text, int, text, int) to service_role;
grant execute on function app.promote_research_report(uuid) to service_role;
grant execute on function public.consume_quota_rpc(text, text, int, text, int) to service_role;
grant execute on function public.promote_research_report_rpc(uuid) to service_role;
grant execute on function app.holder(uuid) to anon, authenticated, service_role;

-- Public, security_invoker view the Overview merges with todays_discounts_feed (report status drives the labels).
create or replace view public.v_card_research with (security_invoker = true) as
select t.scan_run_id, t.mode, t.security_id, t.operational_category, t.category_reason, t.withheld,
       t.research_report_id, t.research_summary, t.conclusion, t.bankruptcy_risk, t.research_completed_at,
       r.status as report_status, r.error as report_error, r.step as report_step,
       r.provider, r.model, r.prompt_version
  from public.todays_discounts t
  left join public.research_reports r on r.id = t.research_report_id;
grant select on public.v_card_research to anon, authenticated;

-- Settings seed (spec 9.8, verbatim).
insert into public.app_settings (key, value, description, is_public)
values ('research',
        '{"max_full_reports_per_day": 4, "tavily_daily_cap": 32, "tavily_monthly_budget": 950, "llm_daily_request_cap": 300, "max_change_checks_per_day": 40, "reuse_days": 30, "tavily_reserved_for_reports": 24}'::jsonb,
        'Research caps and reuse window (spec 9.8); counters live in ai_quota_usage (UTC periods)',
        false)
on conflict (key) do nothing;

-- RLS (spec 6.9). Writes are service role only: no write policies and no write grants.
alter table public.research_reports enable row level security;
alter table public.research_sources enable row level security;
alter table public.research_work_texts enable row level security;
alter table public.ai_quota_usage enable row level security;
alter table public.risk_monitor_state enable row level security;
alter table public.risk_findings enable row level security;

revoke all on public.research_reports, public.research_sources, public.research_work_texts,
  public.ai_quota_usage, public.risk_monitor_state, public.risk_findings from anon, authenticated;
grant select on public.research_reports, public.research_sources to anon, authenticated;
grant select on public.risk_monitor_state, public.risk_findings to authenticated;

drop policy if exists research_reports_public on public.research_reports;
create policy research_reports_public on public.research_reports
  for select to anon, authenticated using (visibility = 'public');
drop policy if exists research_reports_holders on public.research_reports;
create policy research_reports_holders on public.research_reports
  for select to authenticated using (visibility = 'holders' and app.holder(security_id));

drop policy if exists research_sources_public on public.research_sources;
create policy research_sources_public on public.research_sources
  for select to anon, authenticated using (
    exists (select 1 from public.research_reports r where r.id = report_id and r.visibility = 'public'));
drop policy if exists research_sources_holders on public.research_sources;
create policy research_sources_holders on public.research_sources
  for select to authenticated using (
    exists (select 1 from public.research_reports r
             where r.id = report_id and r.visibility = 'holders' and app.holder(r.security_id)));

drop policy if exists risk_monitor_state_owner on public.risk_monitor_state;
create policy risk_monitor_state_owner on public.risk_monitor_state
  for select to authenticated using (user_id = auth.uid());
drop policy if exists risk_findings_owner on public.risk_findings;
create policy risk_findings_owner on public.risk_findings
  for select to authenticated using (user_id = auth.uid());
-- ai_quota_usage and research_work_texts: no policies, deny by default (service role bypasses RLS).
