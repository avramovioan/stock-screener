-- P5a: profile bootstrap, own-row profile access, audit RPC (spec 6.3, 6.8, 6.9, 11.9).
-- Builds on P1: public.profiles already has display_name, updated_at (touched by profiles_touch),
-- column grants and own-row policies; public.audit_events uses (actor_id, action, details).

do $$
begin
  if to_regclass('public.profiles') is null or to_regclass('public.audit_events') is null then
    raise exception 'P5a needs public.profiles and public.audit_events from P1';
  end if;
end $$;

-- 1. profile constraint -------------------------------------------------------------------------
alter table public.profiles drop constraint if exists profiles_display_name_length;
alter table public.profiles add constraint profiles_display_name_length
  check (display_name is null or char_length(display_name) between 1 and 60);

-- 2. bootstrap trigger --------------------------------------------------------------------------
create or replace function app.profile_display_name(p_meta jsonb) returns text
language sql immutable set search_path = '' as $$
  select left(coalesce(
    nullif(btrim(p_meta ->> 'display_name'), ''),
    nullif(btrim(p_meta ->> 'full_name'), ''),
    nullif(btrim(p_meta ->> 'name'), '')), 60)
$$;

create or replace function app.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (user_id, display_name)
  values (new.id, app.profile_display_name(new.raw_user_meta_data))
  on conflict (user_id) do nothing;
  return new;
end $$;

revoke all on function app.handle_new_user() from public, anon, authenticated;
-- the auth service inserts into auth.users, so its role must be able to reach the function
grant usage on schema app to supabase_auth_admin;
grant execute on function app.handle_new_user() to supabase_auth_admin;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function app.handle_new_user();

-- users that signed up before this migration
insert into public.profiles (user_id, display_name)
select u.id, app.profile_display_name(u.raw_user_meta_data) from auth.users u
on conflict (user_id) do nothing;

-- 3. profiles: own-row access, no client insert/delete, is_admin never exposed -------------------
alter table public.profiles enable row level security;
grant select (updated_at) on public.profiles to authenticated;   -- P1 granted the other safe columns

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- 4. audit_events: read own rows (P1 keeps the admin policy), write only through record_audit ----
alter table public.audit_events enable row level security;
revoke insert, update, delete on public.audit_events from anon, authenticated;

drop policy if exists audit_events_select_own on public.audit_events;
create policy audit_events_select_own on public.audit_events for select to authenticated
  using (actor_id = (select auth.uid()));

create or replace function app.redact_jsonb(p_value jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  v_key text;
  v_val jsonb;
  v_out jsonb;
begin
  if p_value is null then
    return null;
  end if;
  case jsonb_typeof(p_value)
    when 'object' then
      v_out := '{}'::jsonb;
      for v_key, v_val in select e.key, e.value from jsonb_each(p_value) e loop
        if v_key ~* 'token|secret|password|passwd|authorization|cookie|key|email' then
          v_out := v_out || jsonb_build_object(v_key, '[redacted]');
        else
          v_out := v_out || jsonb_build_object(v_key, app.redact_jsonb(v_val));
        end if;
      end loop;
      return v_out;
    when 'array' then
      return coalesce((select jsonb_agg(app.redact_jsonb(e.value)) from jsonb_array_elements(p_value) e), '[]'::jsonb);
    else
      return p_value;
  end case;
end $$;

revoke all on function app.redact_jsonb(jsonb) from public, anon, authenticated;

create or replace function public.record_audit(p_type text, p_meta jsonb default '{}'::jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_meta jsonb;
begin
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if p_type is null or p_type !~ '^auth\.[a-z][a-z_]{2,39}$' then
    raise exception 'event type not allowed' using errcode = '22023';
  end if;
  v_meta := case when p_meta is not null and jsonb_typeof(p_meta) = 'object' then p_meta else '{}'::jsonb end;
  if pg_column_size(v_meta) > 2048 then
    raise exception 'metadata too large' using errcode = '22023';
  end if;
  if (select count(*) from public.audit_events
      where actor_id = v_uid and at > now() - interval '1 hour') >= 60 then
    raise exception 'audit rate limit reached' using errcode = '54000';
  end if;
  insert into public.audit_events (actor_id, action, details)
  values (v_uid, p_type, app.redact_jsonb(v_meta));
end $$;

revoke all on function public.record_audit(text, jsonb) from public, anon;
grant execute on function public.record_audit(text, jsonb) to authenticated;
