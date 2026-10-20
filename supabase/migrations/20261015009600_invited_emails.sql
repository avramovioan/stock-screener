-- Invite-only accounts: the owner lists the e-mails that may create an account in public.invited_emails (Table Editor).
-- The account-access Edge Function (service role) is the only reader; nothing is granted to anon or authenticated.
create table public.invited_emails (
  email text primary key,
  reset_password boolean not null default false,
  note text,
  created_at timestamptz not null default now()
);
alter table public.invited_emails enable row level security;
revoke all on public.invited_emails from anon, authenticated;

create function public.invited_emails_normalise() returns trigger language plpgsql as $$
begin
  new.email := lower(btrim(new.email));
  return new;
end $$;
create trigger invited_emails_normalise before insert or update of email on public.invited_emails
  for each row execute function public.invited_emails_normalise();

-- One lookup for the function: is the e-mail invited (with its reset flag) and which auth user, if any, has it.
create function public.account_access_lookup(p_email text)
returns table (invited boolean, reset_password boolean, user_id uuid)
language sql stable security definer set search_path = public, auth as $$
  with e as (select lower(btrim(p_email)) as email)
  select exists (select 1 from invited_emails i, e where i.email = e.email),
         coalesce((select i.reset_password from invited_emails i, e where i.email = e.email), false),
         (select u.id from auth.users u, e where lower(btrim(u.email)) = e.email limit 1)
$$;
revoke all on function public.account_access_lookup(text) from public, anon, authenticated;
grant execute on function public.account_access_lookup(text) to service_role;

-- Clearing the reset flag after a password was set.
create function public.account_access_clear_reset(p_email text) returns void
language sql security definer set search_path = public as $$
  update invited_emails set reset_password = false where email = lower(btrim(p_email))
$$;
revoke all on function public.account_access_clear_reset(text) from public, anon, authenticated;
grant execute on function public.account_access_clear_reset(text) to service_role;
