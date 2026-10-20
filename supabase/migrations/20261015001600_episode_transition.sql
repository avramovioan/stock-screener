-- Atomic episode transition (spec 8.4). A threshold change closes the active episode and opens a silent continuation; both happen in one
-- transaction so a failed insert can never leave a closed episode without its continuation (a retry would otherwise open a NEW episode
-- with notify = true and send a duplicate notification).
-- p_open = null closes only. Idempotent: when the episode is already closed for p_session_day and a continuation of it exists, that
-- continuation is returned and nothing changes. Returns the continuation row (or the closed row when p_open is null) as jsonb.
create or replace function app.transition_episode(
  p_close_id uuid, p_close_reason text, p_session_day date, p_open jsonb default null
) returns jsonb language plpgsql security definer set search_path = public, app as $$
declare r signal_episodes; v_new signal_episodes;
begin
  select * into r from signal_episodes where id = p_close_id for update;
  if not found then raise exception 'episode_not_found' using errcode = 'P0002'; end if;

  if r.status = 'closed' then
    if r.closed_session_date is distinct from p_session_day then raise exception 'episode_closed_for_another_session'; end if;
    if p_open is null then return to_jsonb(r); end if;
    select * into v_new from signal_episodes where continues_episode_id = p_close_id order by created_at limit 1;
    if found then return to_jsonb(v_new); end if;
  else
    update signal_episodes
       set status = 'closed', closed_scan_run_id = coalesce((p_open ->> 'opened_scan_run_id')::uuid, r.opened_scan_run_id),
           closed_session_date = p_session_day, close_reason = p_close_reason, last_evaluated_session_date = p_session_day
     where id = p_close_id
     returning * into r;
    if p_open is null then return to_jsonb(r); end if;
  end if;

  insert into signal_episodes (security_id, company_id, kind, mode, threshold_line, opened_scan_run_id, opened_session_date, opened_close,
                               opened_line_value, opened_rank, open_reason, continues_episode_id, notify, last_evaluated_session_date, rank_history)
  select o.security_id, o.company_id, o.kind, o.mode, o.threshold_line, o.opened_scan_run_id, o.opened_session_date, o.opened_close,
         o.opened_line_value, o.opened_rank, o.open_reason, p_close_id, coalesce(o.notify, false), o.last_evaluated_session_date,
         coalesce(o.rank_history, '[]'::jsonb)
    from jsonb_populate_record(null::signal_episodes, p_open) o
  returning * into v_new;
  return to_jsonb(v_new);
end $$;
