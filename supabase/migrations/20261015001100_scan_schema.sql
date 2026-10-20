-- P1 / migration 2 of 4: scan execution, universe, signals, today's discounts. Spec sections 6.3.3, 6.3.4, 6.5, 7.11, 8.2.

create table scan_runs (
  id uuid primary key default gen_random_uuid(),
  scan_date_local date not null unique,                   -- Europe/Sofia date; the idempotency key of the daily start
  status scan_status not null default 'queued',
  trigger text not null default 'cron' check (trigger in ('cron','cron_catchup','manual')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  last_heartbeat_at timestamptz,
  settings_snapshot jsonb not null,                       -- indicator settings, thresholds, caps used (reproducibility)
  code_version text,
  coverage jsonb not null default '{}',                   -- 7.7
  universe_sizes jsonb not null default '{}',             -- {"worldwide":{"members":..},"us":{...}}
  session_dates jsonb not null default '{}',              -- per exchange last completed session date
  latest_session_date date,                               -- max over processed securities
  results_published_at timestamptz,                       -- per-security results and cards (also for partial scans)
  list_published_at timestamptz,                          -- company list / summary (coverage >= 95% or complete, A-15)
  digest_cutoff_at timestamptz,                           -- 13:00 Sofia of scan_date_local
  digests_created_at timestamptz,
  errors_summary jsonb not null default '{}',
  updated_at timestamptz not null default now()
);
create trigger scan_runs_touch before update on scan_runs for each row execute function app.touch_updated_at();
alter table market_cap_snapshots add constraint market_cap_snapshots_run_fk
  foreign key (scan_run_id) references scan_runs on delete cascade;

create table scan_jobs (
  id bigint generated always as identity primary key,
  scan_run_id uuid not null references scan_runs on delete cascade,
  stage job_stage not null,
  key text not null,                                      -- idempotency key within the stage (batch id, exchange code, security id...)
  status job_status not null default 'queued',
  priority int not null default 100,
  payload jsonb not null default '{}',
  result jsonb,
  attempts int not null default 0,
  max_attempts int not null default 5,
  not_before timestamptz not null default now(),
  lease_until timestamptz,
  leased_by text,
  last_error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  unique (scan_run_id, stage, key)
);
create index scan_jobs_runnable on scan_jobs (priority, id) where status in ('queued','failed');
create index scan_jobs_leased on scan_jobs (lease_until) where status = 'leased';
create index scan_jobs_created_idx on scan_jobs (created_at);

create table scan_events (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  scan_run_id uuid,
  job_id bigint,
  stage job_stage,
  level text not null check (level in ('debug','info','warn','error')),
  event text not null,                                    -- machine code, e.g. yahoo_429, security_failed
  security_id uuid,
  message text,
  data jsonb                                              -- redacted (15.6)
);
create index scan_events_run_at_idx on scan_events (scan_run_id, at);
create index scan_events_at_idx on scan_events (at);

create table scan_security_results (                      -- one row per processed security per scan, mode independent
  id bigint generated always as identity primary key,
  scan_run_id uuid not null references scan_runs on delete cascade,
  security_id uuid not null references securities,
  scope text not null check (scope in ('universe','holding_only')),
  status text not null check (status in ('processed','skipped','failed','insufficient_data','stale','unprocessed')),
  reason_codes text[] not null default '{}',              -- RuleCode values (4.6)
  session_date date,
  close float8,
  freshness freshness_status,
  valid_bars int,
  bars_hash text,                                         -- hash of the 2,500-bar window (reproducibility)
  channel jsonb,                                          -- {slope, average, intercept, stdDev, pearsonR, upDev, dnDev, st, end, base, upper1, ...}
  market_cap_usd float8,
  tier1_member boolean not null default false,
  computed_at timestamptz not null default now(),
  unique (scan_run_id, security_id)
);
create index scan_security_results_security_idx on scan_security_results (security_id);
create index scan_security_results_status_idx on scan_security_results (scan_run_id, status);

create table universe_snapshots (
  id bigint generated always as identity primary key,
  scan_run_id uuid not null references scan_runs on delete cascade,
  mode universe_mode not null,
  security_id uuid not null references securities,
  company_id uuid not null references companies,
  rank int not null,
  market_cap_usd float8 not null,
  is_top10 boolean not null,
  state text not null default 'member' check (state in ('member','carried_forward')),
  applicable_line threshold_line not null,                -- '-3' or '-4' from the rank
  lower_line_end float8,
  close float8,
  session_date date,
  lower_line_positive boolean,
  is_discount boolean not null default false,
  ranked_at timestamptz not null default now(),
  unique (scan_run_id, mode, security_id),
  unique (scan_run_id, mode, rank)
);
create index universe_snapshots_security_idx on universe_snapshots (security_id);

create table universe_membership_events (
  id bigint generated always as identity primary key,
  scan_run_id uuid not null references scan_runs on delete cascade,
  event_date date not null,
  mode universe_mode not null,
  company_id uuid not null references companies,
  security_id uuid references securities,
  event text not null check (event in ('added','removed')),
  from_rank int,
  to_rank int,
  reason text not null,                                   -- market_cap_below_threshold, channel_not_rising, delisted_or_missing, new_listing ...
  unique (scan_run_id, mode, company_id, event)
);
create index universe_membership_events_date_idx on universe_membership_events (event_date);

create table signal_episodes (
  id uuid primary key default gen_random_uuid(),
  security_id uuid not null references securities,
  company_id uuid not null references companies,
  kind signal_kind not null,
  mode universe_mode not null,                            -- premium kinds always use mode 'worldwide' (A-14)
  threshold_line threshold_line not null,
  status episode_status not null default 'active',
  opened_scan_run_id uuid not null references scan_runs,
  opened_session_date date not null,
  opened_close float8 not null,
  opened_line_value float8 not null,
  opened_rank int,
  open_reason text not null check (open_reason in ('new_entry','rank_change_new_threshold','continuation')),
  continues_episode_id uuid references signal_episodes,   -- threshold change without interruption (8.4)
  notify boolean not null default true,
  last_evaluated_session_date date not null,
  closed_scan_run_id uuid references scan_runs,
  closed_session_date date,
  close_reason text check (close_reason in ('close_above_threshold','threshold_changed','close_below_upper_line')),
  rank_history jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'closed') = (closed_session_date is not null))
);
create unique index signal_one_active on signal_episodes (security_id, kind, mode, threshold_line) where status = 'active';
-- a security has at most one active discount episode per mode even across threshold changes (8.2)
create unique index signal_one_active_discount on signal_episodes (security_id, mode) where kind = 'discount' and status = 'active';
create index signal_episodes_opened_run_idx on signal_episodes (opened_scan_run_id);
create index signal_episodes_company_idx on signal_episodes (company_id);
create trigger signal_episodes_touch before update on signal_episodes for each row execute function app.touch_updated_at();

create table todays_discounts (
  id bigint generated always as identity primary key,
  scan_run_id uuid not null references scan_runs on delete cascade,
  mode universe_mode not null,
  security_id uuid not null references securities,
  company_id uuid not null references companies,
  episode_id uuid not null references signal_episodes,
  is_new_episode boolean not null,
  rank int not null,
  market_cap_usd float8,
  market_cap_native float8,
  market_cap_ccy text,
  close float8 not null,
  currency text not null,
  session_date date not null,
  threshold_line threshold_line not null,
  lower_line_end float8 not null,
  channel jsonb not null,                                 -- endpoints and deviation levels at decision time
  trend_ok boolean not null,
  eligibility jsonb not null,
  operational_category operational_category not null,
  category_reason text not null,
  report_id uuid,                                         -- FK to research_reports arrives with P2
  conclusion text,
  bankruptcy_risk bankruptcy_risk,
  summary text,
  research_completed_at timestamptz,
  eur_equivalent_id uuid,                                 -- FK to eur_equivalents arrives with P2
  data_freshness freshness_status not null,
  display_order int not null,
  withheld boolean not null default false,                -- red / grey / pending
  created_at timestamptz not null default now(),
  unique (scan_run_id, mode, security_id)
);
create index todays_discounts_order_idx on todays_discounts (scan_run_id, mode, display_order);

comment on table scan_runs is 'One row per Sofia calendar day (scan_date_local UNIQUE = the idempotency key of the daily start, 7.2).';
comment on table scan_jobs is 'Leased job queue (FOR UPDATE SKIP LOCKED, 6.6.2). UNIQUE (scan_run_id, stage, key) makes seeding idempotent.';
comment on table scan_events is 'Durable structured log (platform logs live one day on Free). data is redacted before insert (15.6).';
comment on table scan_security_results is 'One row per processed security per scan; unprocessed securities never render as passing (7.7).';
comment on table universe_snapshots is 'Ranks per scan and mode; never rewritten after publication (4.7).';
comment on table universe_membership_events is 'Added/removed events written only for list-published snapshots (7.7). Retained 90 days.';
comment on table signal_episodes is 'One continuous run of a signal condition. Partial unique indexes enforce one active episode (8.2).';
comment on table todays_discounts is 'Technical part of the cards for every active discount episode; research fields are filled by classify (8.3.1).';
