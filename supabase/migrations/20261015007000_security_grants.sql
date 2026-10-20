-- P7 security review (findings S-07 and S-20): execute grants.
-- Supabase default privileges grant EXECUTE on new functions to anon and authenticated; `revoke ... from public` does not remove them.

-- S-07: public.is_admin() is used by RLS policies of authenticated only; anon never needs it.
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated, service_role;

-- S-20: RLS of research_reports and research_sources called app.holder() as the invoking role, which forced an EXECUTE grant
-- to anon/authenticated. Repoint both policies to public.holds_security() (same body since P5b: broker_positions lookup,
-- already granted to authenticated only) so that app.holder can be locked down.
drop policy if exists research_reports_holders on public.research_reports;
create policy research_reports_holders on public.research_reports
  for select to authenticated using (visibility = 'holders' and public.holds_security(security_id));
drop policy if exists research_sources_holders on public.research_sources;
create policy research_sources_holders on public.research_sources
  for select to authenticated using (
    exists (select 1 from public.research_reports r
             where r.id = report_id and r.visibility = 'holders' and public.holds_security(r.security_id)));

revoke all on function app.holder(uuid) from public, anon, authenticated;
grant execute on function app.holder(uuid) to service_role;

revoke all on function app.fail_job(bigint, text, interval, boolean, text) from public, anon, authenticated;
grant execute on function app.fail_job(bigint, text, interval, boolean, text) to service_role;

revoke all on function app.profile_display_name(jsonb) from public, anon, authenticated;
grant execute on function app.profile_display_name(jsonb) to service_role;

-- trigger functions: the trigger fires without an EXECUTE check, so no role needs a grant
revoke all on function app.audit_eur_override() from public, anon, authenticated;
revoke all on function app.notification_preferences_guard() from public, anon, authenticated;

-- future app functions start closed; each migration grants what it needs (usually service_role)
alter default privileges in schema app revoke execute on functions from public;
alter default privileges in schema app revoke execute on functions from anon, authenticated;
