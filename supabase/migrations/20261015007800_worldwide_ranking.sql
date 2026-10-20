-- Owner decisions 2026-10-16: one worldwide ranking (the US is only a view filter on the Overview), no AI daily report cap, a digest
-- country filter instead of per-mode digests. The earlier US-default draft of this migration (profiles.universe_mode, the research
-- "does anyone want worldwide" function) was never pushed and is gone.

-- Digests: the mode default is worldwide (no row migration; the pipeline may keep computing `us` rows but nothing user-facing reads them).
alter table public.notification_preferences alter column digest_modes set default '{worldwide}';

-- Digest country filter: null = all countries, 'United States' = US companies only. Same grants as the other preference columns
-- (table-level select, column-level insert and update; own row only through the existing policies).
alter table public.notification_preferences add column if not exists digest_country_filter text null;
grant insert (digest_country_filter) on public.notification_preferences to authenticated;
grant update (digest_country_filter) on public.notification_preferences to authenticated;

-- No per-day cap on full reports (null = unlimited). The other keys (Tavily and LLM free-quota guards) are kept.
update public.app_settings
   set value = jsonb_set(value, '{max_full_reports_per_day}', 'null'::jsonb)
 where key = 'research';
