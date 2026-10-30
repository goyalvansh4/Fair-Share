-- One owner per space, plus optional helper admins.
--   * The creator is the owner. The owner cannot be demoted, removed, or leave: ownership must be transferred first.
--   * Helper admins can run the space (expenses, invitations, members, statements) but cannot touch the owner
--     or other admins, and cannot make anyone an admin. A helper admin can manage members and viewers, and may leave.
--   * Only the owner (or an elevated platform admin) promotes or demotes admins and transfers ownership.
-- Combined with 0014, a person is admin of at most one space.

alter table public.organizations add column owner_id uuid references auth.users(id) on delete restrict;

-- Existing spaces: the creator if still an active admin, otherwise the longest-serving active admin.
update public.organizations o
set owner_id = coalesce(
  (select m.user_id from public.organization_members m
   where m.organization_id = o.id and m.user_id = o.created_by and m.role = 'admin' and m.status = 'active'),
  (select m.user_id from public.organization_members m
   where m.organization_id = o.id and m.role = 'admin' and m.status = 'active'
   order by m.joined_at nulls last, m.created_at limit 1),
  o.created_by
);
alter table public.organizations alter column owner_id set not null;

create or replace function public.set_organization_owner()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.owner_id := new.created_by;
  return new;
end;
$$;
create trigger organizations_set_owner_before_insert
before insert on public.organizations
for each row execute function public.set_organization_owner();

create or replace function public.set_member_role(p_organization_id uuid, p_user_id uuid, p_role public.organization_role)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_owner uuid;
  v_is_owner boolean;
  v_current public.organization_role;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_role is null or p_user_id is null then
    raise exception 'Invalid member details' using errcode = '22023';
  end if;
  select owner_id into v_owner from public.organizations where id = p_organization_id and deleted_at is null for update;
  if not found then
    raise exception 'Organization not found' using errcode = '22023';
  end if;
  if not public.has_org_role(p_organization_id, array['admin']::public.organization_role[]) then
    raise exception 'Only organization admins can change roles' using errcode = '42501';
  end if;
  v_is_owner := v_actor = v_owner or public.is_platform_admin();

  select role into v_current
  from public.organization_members
  where organization_id = p_organization_id and user_id = p_user_id and status = 'active'
  for update;
  if not found then
    raise exception 'That person is not an active member' using errcode = '22023';
  end if;
  if v_current = p_role then
    return;
  end if;
  if p_user_id = v_owner then
    raise exception 'The owner cannot be demoted. Transfer ownership first.' using errcode = '22023';
  end if;

  if p_role = 'admin' then
    if not v_is_owner then
      raise exception 'Only the owner can make someone an admin.' using errcode = '42501';
    end if;
    if public.is_admin_of_other_space(p_user_id, p_organization_id) then
      raise exception 'This person already manages another space. Each person can be admin of only one space.' using errcode = '22023';
    end if;
  elsif v_current = 'admin' and not v_is_owner then
    raise exception 'Only the owner can change an admin''s role.' using errcode = '42501';
  end if;

  update public.organization_members
  set role = p_role
  where organization_id = p_organization_id and user_id = p_user_id;

  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, details)
  values (p_organization_id, v_actor, 'member.role_changed', 'member', p_user_id::text,
    jsonb_build_object('from', v_current, 'to', p_role));
end;
$$;

create or replace function public.remove_organization_member(p_organization_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_owner uuid;
  v_is_owner boolean;
  v_role public.organization_role;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  select owner_id into v_owner from public.organizations where id = p_organization_id and deleted_at is null for update;
  if not found then
    raise exception 'Organization not found' using errcode = '22023';
  end if;
  if v_actor <> p_user_id
    and not public.has_org_role(p_organization_id, array['admin']::public.organization_role[]) then
    raise exception 'Only organization admins can remove members' using errcode = '42501';
  end if;
  v_is_owner := v_actor = v_owner or public.is_platform_admin();

  select role into v_role
  from public.organization_members
  where organization_id = p_organization_id and user_id = p_user_id and status = 'active'
  for update;
  if not found then
    raise exception 'That person is not an active member' using errcode = '22023';
  end if;
  if p_user_id = v_owner then
    raise exception 'The owner cannot leave or be removed. Transfer ownership to another member first.' using errcode = '22023';
  end if;
  if v_role = 'admin' and v_actor <> p_user_id and not v_is_owner then
    raise exception 'Only the owner can remove another admin.' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.settlements st
    where st.organization_id = p_organization_id and st.status = 'pending'
      and (st.from_member_id = p_user_id or st.to_member_id = p_user_id)
  ) then
    raise exception 'Resolve pending payments involving this member first.' using errcode = '22023';
  end if;
  if public.member_net_balance(p_organization_id, p_user_id) <> 0 then
    raise exception 'This member is not settled up yet. Settle their balance before removing them.' using errcode = '22023';
  end if;

  update public.organization_members
  set status = 'removed'
  where organization_id = p_organization_id and user_id = p_user_id;

  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, details)
  values (p_organization_id, v_actor, case when v_actor = p_user_id then 'member.left' else 'member.removed' end,
    'member', p_user_id::text, jsonb_build_object('role', v_role));
end;
$$;

-- Hand the space to another member. They become owner (and admin); the previous owner becomes a regular member.
create or replace function public.transfer_organization_ownership(p_organization_id uuid, p_new_owner_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_owner uuid;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  select owner_id into v_owner from public.organizations where id = p_organization_id and deleted_at is null for update;
  if not found then
    raise exception 'Organization not found' using errcode = '22023';
  end if;
  if v_actor <> v_owner and not public.is_platform_admin() then
    raise exception 'Only the owner can transfer ownership' using errcode = '42501';
  end if;
  if p_new_owner_id is null or p_new_owner_id = v_owner then
    raise exception 'Choose another member to become the owner' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.organization_members
    where organization_id = p_organization_id and user_id = p_new_owner_id and status = 'active'
  ) then
    raise exception 'The new owner must be an active member' using errcode = '22023';
  end if;
  if public.is_admin_of_other_space(p_new_owner_id, p_organization_id) then
    raise exception 'This person already manages another space. Each person can be admin of only one space.' using errcode = '22023';
  end if;

  update public.organizations set owner_id = p_new_owner_id where id = p_organization_id;
  update public.organization_members set role = 'admin'
  where organization_id = p_organization_id and user_id = p_new_owner_id;
  -- The previous owner steps back to a regular member; the new owner can promote them again if wanted.
  update public.organization_members set role = 'member'
  where organization_id = p_organization_id and user_id = v_owner;

  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, details)
  values (p_organization_id, v_actor, 'organization.ownership_transferred', 'organization', p_organization_id::text,
    jsonb_build_object('from', v_owner, 'to', p_new_owner_id));
end;
$$;

revoke all on function public.transfer_organization_ownership(uuid, uuid) from public;
grant execute on function public.transfer_organization_ownership(uuid, uuid) to authenticated;
