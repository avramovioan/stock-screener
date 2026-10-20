-- Identity canonical clear (hosted defect 2026-10-19): app.apply_identity_groups cleared is_canonical only for the group's own members,
-- so a target company that still held a canonical security outside the group (grouped elsewhere, or dropped from the listing set)
-- made the new canonical collide on securities_one_canonical and the whole `group` job failed. The function now clears every other
-- canonical of the target company before setting the group's one, and reports the number as canonical_displaced.
-- Forward-only and replay-safe: create or replace of the 20261015008400 definition, no schema change (role 'other' is allowed by the
-- securities.role check).

create or replace function app.apply_identity_groups(p_groups jsonb) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare g jsonb; v_members uuid[]; v_canonical uuid; v_groups int := 0; v_deleted int := 0; v_deactivated int := 0; v_displaced int := 0;
        v_n int; o record;
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
      update securities
         set is_canonical = false, role = case when role = 'canonical' then 'other' else role end
       where company_id = (g ->> 'company_id')::uuid and is_canonical and id <> v_canonical;
      get diagnostics v_n = row_count;
      v_displaced := v_displaced + v_n;
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
  return jsonb_build_object('groups', v_groups, 'orphans_deleted', v_deleted, 'orphans_deactivated', v_deactivated,
                            'canonical_displaced', v_displaced);
end $$;
