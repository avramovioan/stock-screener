-- Atomic per-key counter for the quotes function rate limit (spec 5.9, 60 requests per minute per hashed IP).
-- Counter rows live in quote_cache under keys rl:<fn>:<ip hash>:<minute>; retention removes expired rows.
create or replace function public.quotes_rl_incr(p_key text, p_expires timestamptz)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v int;
begin
  insert into quote_cache as q (key, payload, provider, fetched_at, expires_at, hit_count)
  values (p_key, '{}'::jsonb, 'ratelimit', now(), p_expires, 1)
  on conflict (key) do update set hit_count = q.hit_count + 1
  returning q.hit_count into v;
  return v;
end
$$;

revoke all on function public.quotes_rl_incr(text, timestamptz) from public, anon, authenticated;
grant execute on function public.quotes_rl_incr(text, timestamptz) to service_role;
