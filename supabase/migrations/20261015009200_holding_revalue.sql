-- Migration 20261015009200: re-evaluate one holding's valuation on request, once per holding per 24 h.
-- A user who links IBKR after the morning scan has no valuation tag until the next daily scan; the portfolio-refresh function's
-- `revalue` action recomputes it from the latest published run. This adds the stamp column and the atomic 24 h claim (same pattern as
-- app.claim_manual_refresh: ONE UPDATE ... WHERE, never check-then-write). Forward-only and replay-safe; service_role only.

alter table public.broker_positions add column if not exists valuation_revalued_at timestamptz;

create or replace function app.claim_holding_revalue(p_user uuid, p_conid bigint)
returns table (outcome text, signal_security_id uuid, next_allowed_at timestamptz)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_sig uuid; v_at timestamptz; v_date date;
begin
  -- the holding is the caller's rows of this conid on their newest statement day (the rows the daily stage tags)
  select max(m.report_date) into v_date from public.broker_positions m where m.user_id = p_user;
  if not exists (select 1 from public.broker_positions p where p.user_id = p_user and p.conid = p_conid and p.report_date = v_date) then
    return query select 'not_found'::text, null::uuid, null::timestamptz;
    return;
  end if;
  update public.broker_positions p set valuation_revalued_at = now()
   where p.user_id = p_user and p.conid = p_conid and p.report_date = v_date
     and p.signal_security_id is not null
     and (p.valuation_revalued_at is null or p.valuation_revalued_at <= now() - interval '24 hours')
  returning p.signal_security_id into v_sig;
  if found then
    return query select 'claimed'::text, v_sig, now() + interval '24 hours';
    return;
  end if;
  select p.signal_security_id, max(p.valuation_revalued_at) + interval '24 hours' into v_sig, v_at
    from public.broker_positions p where p.user_id = p_user and p.conid = p_conid and p.report_date = v_date
   group by p.signal_security_id order by 1 nulls last limit 1;
  if v_sig is null then
    return query select 'not_screened'::text, null::uuid, null::timestamptz;
  else
    return query select 'cooldown'::text, v_sig, v_at;
  end if;
end $$;

revoke all on function app.claim_holding_revalue(uuid, bigint) from public, anon, authenticated;
grant execute on function app.claim_holding_revalue(uuid, bigint) to service_role;
