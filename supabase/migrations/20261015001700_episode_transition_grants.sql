-- Lock-down for app.transition_episode per the app-function convention (see 20261015001200_pipeline_functions.sql header):
-- no execute for public/anon/authenticated; only the service role (worker-tick) may call it.
revoke all on function app.transition_episode(uuid, text, date, jsonb) from public, anon, authenticated;
grant execute on function app.transition_episode(uuid, text, date, jsonb) to service_role;
