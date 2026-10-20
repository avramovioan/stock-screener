-- P2 / research pipeline stages (spec 7.4 stages 7-11). Forward-only, replay-safe (create or replace).
-- app.next_stage_to_seed walks "slots" instead of bare stages, because `classify` and `publish` run twice per scan:
--   ... rank_signals, classify:initial, publish:initial, news, research, classify:final, publish:final.
-- A slot is seeded when it has no job yet and the slot before it is fully terminal (done or dead). It still returns the
-- job_stage; the worker's seeder for classify / publish seeds the `:final` key once the `:initial` job exists.
-- portfolio_scan (stage 8) arrives with P5b and slots in between publish:initial and news.
-- A dead job in a critical stage (fx, rank_signals) stops the pipeline.
create or replace function app.next_stage_to_seed(p_run uuid) returns job_stage
language plpgsql stable security definer set search_path = public, app as $$
declare
  v_stages job_stage[] := array['fx','universe_sweep','identity','fetch_bars','compute','rank_signals',
                                'classify','publish','news','research','classify','publish']::job_stage[];
  v_keys   text[]      := array['%','%','%','%','%','%',
                                'classify:initial','publish:initial','%','%','classify:final','publish:final'];
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
