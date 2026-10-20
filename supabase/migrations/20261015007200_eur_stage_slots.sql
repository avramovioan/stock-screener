-- P6 / EUR stage slots (spec 7.4): eur_catalogue (weekly IBKR catalogue import) right after identity, eur_resolve (stage 9) right after news.
-- Forward-only, replay-safe (create or replace). Sorts after 20261015007100, so apply with `supabase migration up --include-all`.
-- Everything else is identical to 20261015007100. Both new stages are always seeded by the handlers' seeders (eur_catalogue: one job per run
-- that records its decision; eur_resolve: no keys leaves the `_empty` done marker via app.seed_stage), so a run without candidates completes.
create or replace function app.next_stage_to_seed(p_run uuid) returns job_stage
language plpgsql stable security definer set search_path = public, app as $$
declare
  v_stages job_stage[] := array['fx','universe_sweep','identity','eur_catalogue','fetch_bars','compute','rank_signals',
                                'classify','publish','portfolio_scan','news','eur_resolve','research','classify','publish','digest']::job_stage[];
  v_keys   text[]      := array['%','%','%','%','%','%','%',
                                'classify:initial','publish:initial','%','%','%','%','classify:final','publish:final','digest'];
  i int; v_cnt int; v_open int; v_dead int;
begin
  for i in 1 .. array_length(v_stages, 1) loop
    select count(*) into v_cnt from scan_jobs where scan_run_id = p_run and stage = v_stages[i] and key like v_keys[i];
    if v_cnt = 0 then
      if i = 1 then return v_stages[i]; end if;
      select count(*) filter (where status in ('queued', 'leased', 'failed')), count(*) filter (where status = 'dead')
        into v_open, v_dead
        from scan_jobs where scan_run_id = p_run and stage = v_stages[i - 1] and key like v_keys[i - 1];
      if v_open > 0 then return null; end if;
      if v_stages[i - 1] in ('fx', 'rank_signals') and v_dead > 0 then return null; end if;
      return v_stages[i];
    end if;
  end loop;
  return null;
end $$;

revoke all on function app.next_stage_to_seed(uuid) from public, anon, authenticated;
grant execute on function app.next_stage_to_seed(uuid) to service_role;
