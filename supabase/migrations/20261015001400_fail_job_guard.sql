-- Guard app.fail_job by lease state. A worker that lost its lease (job already done, dead, re-queued or leased by another worker)
-- must not be able to rewrite the job: complete_job, defer_job and heartbeat_job already require status = 'leased'.
-- Adds an optional p_worker: when passed, the lease owner must match. The old 4-argument function is dropped so calls stay unambiguous.
-- Returns: 'failed' or 'dead' when the failure was applied; NULL when nothing changed (job missing, not leased, or leased by another worker).
drop function if exists app.fail_job(bigint, text, interval, boolean);

create or replace function app.fail_job(
  p_id bigint, p_error text, p_retry_in interval default null, p_fatal boolean default false, p_worker text default null
) returns job_status language plpgsql security definer set search_path = public, app as $$
declare r scan_jobs; v_status job_status; v_delay interval;
begin
  select * into r from scan_jobs where id = p_id for update;
  if not found then return null; end if;
  if r.status <> 'leased' or (p_worker is not null and r.leased_by is distinct from p_worker) then
    return null;
  end if;
  if p_fatal or r.attempts >= r.max_attempts then
    v_status := 'dead';
  else
    v_status := 'failed';
    v_delay := coalesce(p_retry_in, make_interval(secs => 60 * power(2, greatest(r.attempts - 1, 0)) * (1 + random() * 0.25)));
  end if;
  update scan_jobs
     set status = v_status, last_error = left(p_error, 2000), lease_until = null, leased_by = null,
         finished_at = case when v_status = 'dead' then now() else finished_at end,
         not_before = case when v_status = 'failed' then now() + v_delay else not_before end
   where id = p_id;
  return v_status;
end $$;
