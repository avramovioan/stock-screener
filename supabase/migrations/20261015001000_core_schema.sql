-- P1 / migration 1 of 4: enums, reference + market-data tables, seeds. Spec sections 6.2, 6.3.1, 6.3.2, 5.5.
-- RLS, grants and functions follow in 20261015001200_pipeline_functions.sql; every table here is locked down there.

-- ------------------------------------------------------------------ enums (6.2); later phases add their own types
create type universe_mode        as enum ('worldwide', 'us');
create type signal_kind          as enum ('discount', 'premium1', 'premium2');
create type threshold_line       as enum ('-3', '-4', '+1', '+2');
create type scan_status          as enum ('queued', 'running', 'partial', 'complete', 'failed');
create type job_status           as enum ('queued', 'leased', 'done', 'failed', 'dead');      -- failed = attempt failed, retry scheduled
create type job_stage            as enum ('fx','universe_sweep','identity','volume_probe','fetch_bars','compute','rank_signals','portfolio_scan',
                                          'news','research','classify','publish','digest','eur_catalogue','eur_resolve');
create type operational_category as enum ('green', 'amber', 'red', 'grey', 'pending');
create type bankruptcy_risk      as enum ('Low', 'Moderate', 'High', 'Unclear');
create type episode_status       as enum ('active', 'closed');
create type freshness_status     as enum ('fresh', 'stale', 'unavailable');
create type venue_class          as enum ('primary', 'secondary_only', 'otc');

-- ------------------------------------------------------------------ helper trigger
create or replace function app.touch_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ------------------------------------------------------------------ 6.3.1 reference and identity
create table profiles (
  user_id uuid primary key references auth.users on delete cascade,
  display_name text,
  is_admin boolean not null default false,                -- not user-writable (column privileges)
  timezone text not null default 'Europe/Sofia',
  default_destination text not null default 'IBIS2' check (default_destination in ('IBIS2','IBIS','AEB')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger profiles_touch before update on profiles for each row execute function app.touch_updated_at();

create table exchanges (
  code text primary key,                                  -- Yahoo exchange code: NMS, NYQ, GER ...
  name text not null,
  mic text,
  country text not null,                                  -- Yahoo assetProfile naming (5.5)
  timezone text not null,                                 -- IANA
  currencies text[] not null,                             -- major currencies seen on the venue
  venue_class venue_class not null default 'primary',
  screener_enabled boolean not null default true,
  trading_days int[] not null default '{1,2,3,4,5}',      -- ISO weekdays; completeness statistics only
  session_close_local time,                               -- fallback for the forming-bar rule
  max_gap_days int not null default 5,                    -- freshness (A-10)
  tradingview_prefix text,
  tradingview_verified boolean not null default false,
  ibkr_exchange_id text,
  yahoo_suffix text,                                      -- e.g. '.DE'
  us_primary boolean not null default false,              -- NMS, NYQ, NGM
  created_at timestamptz not null default now()
);

create table fx_rates (
  id bigint generated always as identity primary key,
  rate_date date not null,
  ccy char(3) not null,                                   -- MAJOR currency, never GBp
  usd_per_unit float8 not null check (usd_per_unit > 0),
  source text not null check (source in ('frankfurter','yahoo')),
  source_symbol text,
  retrieved_at timestamptz not null default now(),
  unique (rate_date, ccy)
);

create table companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  name_normalized text not null,
  canonical_security_id uuid,                             -- FK added after securities (deferrable)
  country text, sector text, industry text,
  profile_refreshed_at timestamptz,
  sec_cik text,
  ir_rss_urls text[] not null default '{}',
  news_symbol text,
  status text not null default 'active' check (status in ('active','inactive')),
  identity_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index companies_name_normalized_idx on companies (name_normalized);
create trigger companies_touch before update on companies for each row execute function app.touch_updated_at();

create table securities (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies,
  yahoo_symbol text not null unique,
  symbol_history jsonb not null default '[]',
  exchange_code text not null references exchanges,
  currency text not null,                                 -- trading currency as Yahoo reports it (GBp, ZAc, ...)
  currency_major text not null,
  minor_divisor int not null default 1,
  quote_type text not null,
  long_name text,
  financial_currency text,
  shares_outstanding bigint,
  first_trade_date date,
  role text not null default 'other' check (role in ('canonical','share_class','adr','foreign_listing','secondary_venue','excluded','other')),
  is_canonical boolean not null default false,
  isin text,                                              -- from the IBKR catalogue / Flex; Yahoo has none
  avg_usd_volume_30d float8,
  volume_probe_at timestamptz,
  status text not null default 'active' check (status in ('active','delisted','suspended')),
  missing_scans int not null default 0,                   -- consecutive scans without data (5.8)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index securities_one_canonical on securities (company_id) where is_canonical;
create index securities_company_idx on securities (company_id);
create index securities_exchange_idx on securities (exchange_code);
create index securities_isin_idx on securities (isin) where isin is not null;
create trigger securities_touch before update on securities for each row execute function app.touch_updated_at();
alter table companies add constraint companies_canonical_fk
  foreign key (canonical_security_id) references securities deferrable initially deferred;

create table security_identity_overrides (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('force_canonical','exclude','force_us','force_not_us','merge_into_company','predecessor_continuity')),
  yahoo_symbol text not null,
  target_company_id uuid references companies,
  payload jsonb not null default '{}',                    -- e.g. {"continuous_since":"2008-05-02"}
  reason text not null,
  active boolean not null default true,
  created_by uuid references auth.users,
  created_at timestamptz not null default now()
);
create index security_identity_overrides_symbol_idx on security_identity_overrides (yahoo_symbol) where active;

-- ------------------------------------------------------------------ 6.3.2 market data
create table price_series (
  security_id uuid primary key references securities on delete cascade,
  bar_dates int4[] not null,                              -- days since 1970-01-01, strictly ascending
  open float8[] not null, high float8[] not null, low float8[] not null, close float8[] not null, volume int8[] not null,
  adjustment_policy text not null default 'yahoo_split_adjusted_close_v1',
  provider text not null default 'yahoo',
  bar_count int not null,
  first_bar_date date not null,
  last_bar_date date not null,
  last_session_date date not null,                        -- last COMPLETED session (forming bar excluded)
  last_close float8 not null,
  prev_close float8,                                      -- denormalised so public lists need no array access (A-41)
  retrieved_at timestamptz not null,
  last_full_refresh_at timestamptz not null,
  completeness jsonb not null default '{}',
  freshness freshness_status not null default 'fresh',
  updated_at timestamptz not null default now(),
  check (bar_count = cardinality(bar_dates) and bar_count = cardinality(open) and bar_count = cardinality(high)
         and bar_count = cardinality(low) and bar_count = cardinality(close) and bar_count = cardinality(volume))
);
create trigger price_series_touch before update on price_series for each row execute function app.touch_updated_at();

create table market_cap_snapshots (
  id bigint generated always as identity primary key,
  scan_run_id uuid not null,                              -- FK to scan_runs added in the next migration
  security_id uuid not null references securities,
  market_cap_native float8,
  currency_major text not null,                           -- original value and currency (brief 4.3)
  fx_usd_per_unit float8, fx_rate_date date, fx_source text,
  market_cap_usd float8,
  shares_outstanding bigint,
  price_time timestamptz,
  source text not null check (source in ('yahoo_screener','yahoo_quote')),
  quality text not null check (quality in ('ok','stale','missing','fx_missing')),
  unique (scan_run_id, security_id)
);
create index market_cap_snapshots_security_idx on market_cap_snapshots (security_id, id desc);

create table quote_cache (
  key text primary key,
  payload jsonb not null,
  provider text not null default 'yahoo',
  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null,
  hit_count int not null default 0
);
create index quote_cache_expires_idx on quote_cache (expires_at);

-- ------------------------------------------------------------------ settings and audit
create table app_settings (
  key text primary key,
  value jsonb not null,
  is_public boolean not null default false,
  description text,
  updated_by uuid references auth.users,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger app_settings_touch before update on app_settings for each row execute function app.touch_updated_at();

create table audit_events (                                -- never deleted (brief 32)
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_id uuid references auth.users on delete set null,
  action text not null,                                   -- e.g. set_setting, override, manual_scan_start
  target_type text,
  target_id text,
  details jsonb not null default '{}'
);
create index audit_events_at_idx on audit_events (at desc);

-- ------------------------------------------------------------------ comments
comment on table profiles is 'One row per user; is_admin is server-controlled (column privileges, 6.8).';
comment on table exchanges is 'Yahoo exchange codes (mic is left null: not evidenced in the research) with timezone, currencies, venue class and deep-link prefixes (5.5, 14.5). Secondary and OTC venues are not swept.';
comment on table fx_rates is 'Daily USD-per-unit rates in MAJOR currency units; one row per (rate_date, ccy) (5.4).';
comment on table companies is 'One row per company; listings of the same company are securities (5.6). Never keyed by ticker.';
comment on table securities is 'One row per Yahoo listing. yahoo_symbol is an attribute with symbol_history, never a key (5.8).';
comment on table security_identity_overrides is 'Audited manual identity decisions applied after the algorithm (5.6).';
comment on table price_series is 'One row per security: split-adjusted, NOT dividend-adjusted daily bars of COMPLETED sessions only (5.11). Arrays are served by get_price_series().';
comment on table market_cap_snapshots is 'Market cap as reported (major unit) with the FX row used, per scan, for reproducibility (4.6).';
comment on table quote_cache is 'Short-lived provider cache and the Yahoo session/breaker state (5.9, 5.11). Purged daily.';
comment on table app_settings is 'Runtime settings: indicator, universe, pipeline. Copied into scan_runs.settings_snapshot at scan start.';
comment on table audit_events is 'Append-only audit trail of operator actions.';

-- ------------------------------------------------------------------ seeds: exchanges (5.5 table; deep links from spike 7)
-- secondary_only and otc venues are not swept (screener_enabled = false): their lines duplicate foreign primaries.
insert into exchanges (code, name, mic, country, timezone, currencies, venue_class, screener_enabled, trading_days, session_close_local,
                       tradingview_prefix, tradingview_verified, ibkr_exchange_id, yahoo_suffix, us_primary) values
 ('NMS', 'NasdaqGS',  null, 'United States',  'America/New_York',    '{USD}',                'primary',        true,  '{1,2,3,4,5}', '16:00', 'NASDAQ',     true,  null,   '',     true),
 ('NYQ', 'NYSE',      null, 'United States',  'America/New_York',    '{USD}',                'primary',        true,  '{1,2,3,4,5}', '16:00', 'NYSE',       true,  null,   '',     true),
 ('NGM', 'NasdaqGM',  null, 'United States',  'America/New_York',    '{USD}',                'primary',        true,  '{1,2,3,4,5}', '16:00', null,         false, null,   '',     true),
 ('GER', 'XETRA',     null, 'Germany',        'Europe/Berlin',       '{EUR,USD}',            'primary',        true,  '{1,2,3,4,5}', '17:30', 'XETR',       true,  'IBIS', '.DE',  false),
 ('FRA', 'Frankfurt', null, 'Germany',        'Europe/Berlin',       '{EUR}',                'secondary_only', false, '{1,2,3,4,5}', '20:00', 'FWB',        true,  null,   '.F',   false),
 ('STU', 'Stuttgart', null, 'Germany',        'Europe/Berlin',       '{EUR}',                'secondary_only', false, '{1,2,3,4,5}', '22:00', null,         false, null,   '.SG',  false),
 ('MUN', 'Munich',    null, 'Germany',        'Europe/Berlin',       '{EUR}',                'secondary_only', false, '{1,2,3,4,5}', '20:00', null,         false, null,   '.MU',  false),
 ('DUS', 'Duesseldorf',null,'Germany',        'Europe/Berlin',       '{EUR}',                'secondary_only', false, '{1,2,3,4,5}', '20:00', null,         false, null,   '.DU',  false),
 ('VIE', 'Vienna',    null, 'Austria',        'Europe/Vienna',       '{EUR}',                'secondary_only', false, '{1,2,3,4,5}', '17:30', null,         false, null,   '.VI',  false),
 ('LSE', 'LSE',       null, 'United Kingdom', 'Europe/London',       '{GBP,USD,SEK,EUR}',    'primary',        true,  '{1,2,3,4,5}', '16:30', 'LSE',        true,  null,   '.L',   false),
 ('IOB', 'International Order Book', null, 'United Kingdom', 'Europe/London', '{GBP,USD,EUR}',  'secondary_only', false, '{1,2,3,4,5}', null,    null,         false, null,   null,   false),
 ('CXE', 'Cboe UK',   null, 'United Kingdom', 'Europe/London',       '{GBP,USD,EUR}',        'secondary_only', false, '{1,2,3,4,5}', null,    null,         false, null,   null,   false),
 ('EBS', 'Swiss',     null, 'Switzerland',    'Europe/Zurich',       '{CHF}',                'primary',        true,  '{1,2,3,4,5}', '17:30', 'SIX',        true,  null,   '.SW',  false),
 ('TOR', 'Toronto',   null, 'Canada',         'America/Toronto',     '{CAD,USD}',            'primary',        true,  '{1,2,3,4,5}', '16:00', 'TSX',        true,  null,   '.TO',  false),
 ('NEO', 'Cboe CA',   null, 'Canada',         'America/Toronto',     '{CAD}',                'secondary_only', false, '{1,2,3,4,5}', null,    null,         false, null,   '.NE',  false),
 ('HKG', 'HKSE',      null, 'Hong Kong',      'Asia/Hong_Kong',      '{HKD}',                'primary',        true,  '{1,2,3,4,5}', '16:00', 'HKEX',       true,  null,   '.HK',  false),
 ('JPX', 'Tokyo',     null, 'Japan',          'Asia/Tokyo',          '{JPY}',                'primary',        true,  '{1,2,3,4,5}', '15:30', 'TSE',        true,  null,   '.T',   false),
 ('SHH', 'Shanghai',  null, 'China',          'Asia/Shanghai',       '{CNY}',                'primary',        true,  '{1,2,3,4,5}', '15:00', 'SSE',        true,  null,   '.SS',  false),
 ('SHZ', 'Shenzhen',  null, 'China',          'Asia/Shanghai',       '{CNY}',                'primary',        true,  '{1,2,3,4,5}', '15:00', 'SZSE',       true,  null,   '.SZ',  false),
 ('TAI', 'Taiwan',    null, 'Taiwan',         'Asia/Taipei',         '{TWD}',                'primary',        true,  '{1,2,3,4,5}', '13:30', 'TWSE',       true,  null,   '.TW',  false),
 ('TWO', 'Taipei Exchange', null, 'Taiwan',   'Asia/Taipei',         '{TWD}',                'primary',        true,  '{1,2,3,4,5}', '13:30', null,         false, null,   '.TWO', false),
 ('KSC', 'KSE',       null, 'South Korea',    'Asia/Seoul',          '{KRW}',                'primary',        true,  '{1,2,3,4,5}', '15:30', 'KRX',        true,  null,   '.KS',  false),
 ('KOE', 'KOSDAQ',    null, 'South Korea',    'Asia/Seoul',          '{KRW}',                'primary',        true,  '{1,2,3,4,5}', '15:30', null,         false, null,   '.KQ',  false),
 ('NSI', 'NSE',       null, 'India',          'Asia/Kolkata',        '{INR}',                'primary',        true,  '{1,2,3,4,5}', '15:30', 'NSE',        true,  null,   '.NS',  false),
 ('BSE', 'BSE',       null, 'India',          'Asia/Kolkata',        '{INR}',                'primary',        true,  '{1,2,3,4,5}', '15:30', null,         false, null,   '.BO',  false),
 ('SAU', 'Saudi',     null, 'Saudi Arabia',   'Asia/Riyadh',         '{SAR}',                'primary',        true,  '{7,1,2,3,4}', '15:00', 'TADAWUL',    true,  null,   '.SR',  false),  -- Sunday-Thursday: UNVERIFIED
 ('ASX', 'ASX',       null, 'Australia',      'Australia/Sydney',    '{AUD}',                'primary',        true,  '{1,2,3,4,5}', '16:00', 'ASX',        true,  null,   '.AX',  false),
 ('AMS', 'Amsterdam', null, 'Netherlands',    'Europe/Amsterdam',    '{EUR}',                'primary',        true,  '{1,2,3,4,5}', '17:30', 'EURONEXT',   true,  'AEB',  '.AS',  false),
 ('PAR', 'Paris',     null, 'France',         'Europe/Paris',        '{EUR}',                'primary',        true,  '{1,2,3,4,5}', '17:30', 'EURONEXT',   true,  null,   '.PA',  false),
 ('MIL', 'Milan',     null, 'Italy',          'Europe/Rome',         '{EUR}',                'primary',        true,  '{1,2,3,4,5}', '17:30', 'MIL',        true,  null,   '.MI',  false),
 ('SES', 'SES',       null, 'Singapore',      'Asia/Singapore',      '{SGD}',                'primary',        true,  '{1,2,3,4,5}', '17:00', 'SGX',        true,  null,   '.SI',  false),
 ('JNB', 'Johannesburg',null,'South Africa',  'Africa/Johannesburg', '{ZAR}',                'primary',        true,  '{1,2,3,4,5}', '17:00', 'JSE',        true,  null,   '.JO',  false),
 ('SAO', 'Sao Paulo', null, 'Brazil',         'America/Sao_Paulo',   '{BRL}',                'primary',        true,  '{1,2,3,4,5}', '17:55', 'BMFBOVESPA', true,  null,   '.SA',  false),
 ('MEX', 'Mexico',    null, 'Mexico',         'America/Mexico_City', '{MXN}',                'secondary_only', false, '{1,2,3,4,5}', null,    'BMV',        true,  null,   '.MX',  false),
 ('BUE', 'Buenos Aires',null,'Argentina',     'America/Argentina/Buenos_Aires', '{ARS}',     'secondary_only', false, '{1,2,3,4,5}', null,    null,         false, null,   '.BA',  false),
 ('PNK', 'OTC Pink',  null, 'United States',  'America/New_York',    '{USD}',                'otc',            false, '{1,2,3,4,5}', null,    null,         false, null,   null,   false),
 ('OQB', 'OTCQB',     null, 'United States',  'America/New_York',    '{USD}',                'otc',            false, '{1,2,3,4,5}', null,    null,         false, null,   null,   false),
 ('OQX', 'OTCQX',     null, 'United States',  'America/New_York',    '{USD}',                'otc',            false, '{1,2,3,4,5}', null,    null,         false, null,   null,   false);

-- ------------------------------------------------------------------ seeds: app_settings (4.2.1, 5.5, 7.4, 7.5)
insert into app_settings (key, value, is_public, description) values
 ('indicator',
  '{"length":2500,"upper1Mode":true,"upper1Mult":1,"upper2Mode":true,"upper2Mult":2,"lower1Mode":true,"lower1Mag":3,"lower2Mode":true,"lower2Mag":4}',
  true, 'Std Dev Channel settings (4.2.1). Changes go through scan-control with an audit row.'),
 ('universe',
  '{"threshold_usd":50000000000,"safety_margin":0.7,"min_history_years":10}',
  true, 'Market-cap floor in USD (inclusive), screener safety margin, listing history requirement.'),
 ('pipeline',
  '{"stage_caps":{"fx":1,"universe_sweep":1,"identity":1,"fetch_bars":1,"compute":2,"rank_signals":1,"classify":1,"publish":1},
    "batch_sizes":{"fetch_bars":12,"compute":25,"quote_batch":500,"profile":25,"volume_probe":12},
    "max_stored_bars":3300,"lease_seconds":180,"claim_limit":3,"stop_claiming_ms":85000,"hard_deadline_ms":120000,
    "list_publish_min_coverage":0.95,"carry_forward_max_scans":3,"max_screener_pages_per_job":10,
    "yahoo":{"min_spacing_ms":340,"jitter_ms":100}}',
  false, 'Worker batch sizes, stage caps, deadlines and Yahoo pacing (7.4, 7.5, 5.3).')
on conflict (key) do nothing;
