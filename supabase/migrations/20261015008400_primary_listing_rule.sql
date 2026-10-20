-- Primary listing rule (owner decision 2026-10-16, A-50): only a company's own primary listing is screened, and only common shares.
-- A company with no eligible primary listing keeps no canonical security and says why in companies.exclusion_reason:
--   no_primary_listing  the home exchange is not in the universe (or the company only has London international order book lines)
--   country_unknown     the home country is unknown and not inferable from exactly one primary listing
--   not_a_share         every listing is a bond, fund, warrant or other non-share instrument
-- Forward-only and safe on top of existing rows: the column is nullable with no default (no rewrite).
--
-- Existing canonical choices need no cleanup here. The identity `group` job runs on every scan, loads every active canonical security
-- and re-chooses each company's canonical listing; a canonical that breaks the rule is not a candidate any more, so it is replaced at
-- once (no volume-ratio hysteresis) or, without a home listing, cleared by this function. Clearing the flags in SQL would only split
-- the company from its home listing, so the data fix is the next scan itself.

alter table public.companies add column if not exists exclusion_reason text
  check (exclusion_reason in ('no_primary_listing', 'country_unknown', 'not_a_share'));

comment on column public.companies.exclusion_reason is 'Why the company has no canonical security and is not screened (no_primary_listing, country_unknown, not_a_share); null while it has one. Written by app.apply_identity_groups on every scan.';

-- The 20261015001200 definition, with exclusion_reason written from each group (absent = null, so a company that regains a canonical
-- listing is cleared).
create or replace function app.apply_identity_groups(p_groups jsonb) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare g jsonb; v_members uuid[]; v_canonical uuid; v_groups int := 0; v_deleted int := 0; v_deactivated int := 0; o record;
begin
  for g in select * from jsonb_array_elements(p_groups) loop
    select array_agg(x::uuid) into v_members from jsonb_array_elements_text(g -> 'member_ids') x;
    v_canonical := nullif(g ->> 'canonical_id', '')::uuid;
    insert into companies (id, name, name_normalized)
    values ((g ->> 'company_id')::uuid, coalesce(g ->> 'name', 'unknown'), coalesce(g ->> 'name_normalized', 'unknown'))
    on conflict (id) do nothing;
    update securities set is_canonical = false where id = any (v_members) and is_canonical;
    update securities s
       set company_id = (g ->> 'company_id')::uuid, role = coalesce(g -> 'roles' ->> s.id::text, 'other'), is_canonical = false
     where s.id = any (v_members);
    if v_canonical is not null then
      update securities set is_canonical = true, role = 'canonical' where id = v_canonical;
    end if;
    update companies
       set canonical_security_id = v_canonical, country = coalesce(g ->> 'country', country), name = coalesce(g ->> 'name', name),
           name_normalized = coalesce(g ->> 'name_normalized', name_normalized), status = 'active',
           exclusion_reason = case when v_canonical is null then nullif(g ->> 'exclusion_reason', '') else null end
     where id = (g ->> 'company_id')::uuid;
    v_groups := v_groups + 1;
  end loop;

  for o in select c.id from companies c where c.status = 'active' and not exists (select 1 from securities s where s.company_id = c.id) loop
    begin
      delete from companies where id = o.id;
      v_deleted := v_deleted + 1;
    exception when foreign_key_violation then
      update companies set status = 'inactive', canonical_security_id = null where id = o.id;
      v_deactivated := v_deactivated + 1;
    end;
  end loop;
  return jsonb_build_object('groups', v_groups, 'orphans_deleted', v_deleted, 'orphans_deactivated', v_deactivated);
end $$;
