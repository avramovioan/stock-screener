-- Spec 10.6: a capped email stays pending until the next UTC day WITHOUT spending an attempt.
-- app.claim_deliveries increments attempts at claim time, so deferral refunds that increment.
create or replace function public.notify_defer_delivery(
  p_id uuid, p_retry_in_seconds int, p_error text, p_log jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  update digest_deliveries d set
    attempts = greatest(d.attempts - 1, 0),
    last_error = p_error,
    next_attempt_at = now() + make_interval(secs => greatest(p_retry_in_seconds, 1)),
    attempt_log = d.attempt_log || jsonb_build_array(p_log || jsonb_build_object('at', now()))
  where d.id = p_id and d.status = 'pending';
end $$;

revoke all on function public.notify_defer_delivery(uuid, int, text, jsonb) from public, anon, authenticated;
grant execute on function public.notify_defer_delivery(uuid, int, text, jsonb) to service_role;
