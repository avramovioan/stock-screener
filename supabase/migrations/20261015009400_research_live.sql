-- Scan with AI, live and shared. Forward-only; every object is guarded so a replay is safe.
-- 1) public.accept_visitor_research: the atomic "one scan per company at a time". It takes a per-security advisory lock, checks for
--    an in-flight report or research job and, when there is none, creates the queued visitor report and its job in the same
--    transaction. Two simultaneous requests serialise on the lock: the second one sees the first one's rows and is refused with
--    that scan's start and requester. (A partial unique index could not express this: a research job can be in flight without a
--    report row, and monitor reports must stay free to coexist.) The feed already shows a queued report as in flight
--    (research_started_at = coalesce(started_at, created_at), research_requested_by = usage.source), so it needs no change.
-- 2) research_reports joins the supabase_realtime publication; anon already selects its public rows (table grant + policy).

create or replace function public.accept_visitor_research(
  p_security_id uuid,
  p_scan_run_id uuid,
  p_accepted_at timestamptz,
  p_report_key text,
  p_job_key text,
  p_priority int,
  p_payload jsonb
) returns table (accepted boolean, report_id uuid, started_at timestamptz, requested_by text)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_company uuid;
  v_id uuid;
  v_started timestamptz;
  v_source text;
begin
  select s.company_id into v_company from securities s where s.id = p_security_id;
  if v_company is null then
    raise exception 'accept_visitor_research: unknown security %', p_security_id;
  end if;

  -- one request per company at a time; released at the end of this transaction
  perform pg_advisory_xact_lock(hashtextextended(p_security_id::text, 1));

  select coalesce(r.started_at, r.created_at), r.usage ->> 'source'
    into v_started, v_source
    from research_reports r
   where r.security_id = p_security_id and r.status in ('queued', 'running', 'quota_deferred')
   order by r.created_at desc, r.id desc
   limit 1;
  if not found then
    -- a research job for the company that has no report row yet (or is waiting for a retry)
    select j.created_at, j.payload ->> 'source'
      into v_started, v_source
      from scan_jobs j
     where j.stage = 'research' and j.status in ('queued', 'leased', 'failed')
       and j.payload ->> 'security_id' = p_security_id::text
     order by j.created_at desc, j.id desc
     limit 1;
  end if;
  if v_started is not null then
    accepted := false;
    report_id := null;
    started_at := v_started;
    requested_by := case when v_source in ('visitor', 'owner', 'system') then v_source end;
    return next;
    return;
  end if;

  insert into research_reports as r (security_id, company_id, scan_run_id, kind, trigger, status, visibility, started_at, usage, idempotency_key)
  values (p_security_id, v_company, p_scan_run_id, 'full', 'visitor', 'queued', 'public', p_accepted_at,
          jsonb_build_object('source', 'visitor'), p_report_key)
  on conflict (idempotency_key) do update
     set status = 'queued', step = null, error = null, completed_at = null, started_at = excluded.started_at,
         usage = excluded.usage, queries_used = 0, docs_fetched = 0
   where r.status = 'failed'
  returning r.id into v_id;
  if v_id is null then
    raise exception 'accept_visitor_research: report key % is already used by a live report', p_report_key;
  end if;

  insert into scan_jobs (scan_run_id, stage, key, priority, payload)
  values (p_scan_run_id, 'research', p_job_key, p_priority, p_payload)
  on conflict (scan_run_id, stage, key) do nothing;

  accepted := true;
  report_id := v_id;
  started_at := p_accepted_at;
  requested_by := 'visitor';
  return next;
end $$;

revoke all on function public.accept_visitor_research(uuid, uuid, timestamptz, text, text, int, jsonb) from public, anon, authenticated;
grant execute on function public.accept_visitor_research(uuid, uuid, timestamptz, text, text, int, jsonb) to service_role;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'research_reports') then
    alter publication supabase_realtime add table public.research_reports;
  end if;
end $$;
