-- One person can be admin of only one space at a time. This stops one account from spinning up unlimited spaces.
-- To create a new space, the person must first hand their current space to someone else (make another member an
-- admin) and leave it; they are then free to create a new one. Existing data is grandfathered: the rule applies to
-- new spaces and new admin promotions. Elevated platform admins are exempt when creating spaces.

create or replace function public.is_admin_of_other_space(p_user_id uuid, p_except_organization_id uuid default null)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.organization_members m
    join public.organizations o on o.id = m.organization_id
    where m.user_id = p_user_id and m.role = 'admin' and m.status = 'active'
      and o.deleted_at is null and o.status = 'active'
      and (p_except_organization_id is null or m.organization_id <> p_except_organization_id)
  );
$$;
revoke all on function public.is_admin_of_other_space(uuid, uuid) from public;

create or replace function public.enforce_single_admin_space_on_create()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if public.is_admin_of_other_space(new.created_by, null) and not public.is_platform_admin() then
    raise exception 'You already manage a space. Make someone else an admin and leave it before creating another.' using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger organizations_single_admin_before_insert
before insert on public.organizations
for each row execute function public.enforce_single_admin_space_on_create();

-- Promoting someone to admin (ownership transfer) is refused if they already manage another space.
create or replace function public.set_member_role(p_organization_id uuid, p_user_id uuid, p_role public.organization_role)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_current public.organization_role;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_role is null or p_user_id is null then
    raise exception 'Invalid member details' using errcode = '22023';
  end if;
  perform 1 from public.organizations where id = p_organization_id and deleted_at is null for update;
  if not found then
    raise exception 'Organization not found' using errcode = '22023';
  end if;
  if not public.has_org_role(p_organization_id, array['admin']::public.organization_role[]) then
    raise exception 'Only organization admins can change roles' using errcode = '42501';
  end if;

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
  if p_role = 'admin' and public.is_admin_of_other_space(p_user_id, p_organization_id) then
    raise exception 'This person already manages another space. Each person can be admin of only one space.' using errcode = '22023';
  end if;
  if v_current = 'admin' and not exists (
    select 1 from public.organization_members
    where organization_id = p_organization_id and status = 'active' and role = 'admin' and user_id <> p_user_id
  ) then
    raise exception 'You are the only admin. Make someone else an admin first (transfer ownership).' using errcode = '22023';
  end if;

  update public.organization_members
  set role = p_role
  where organization_id = p_organization_id and user_id = p_user_id;

  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, details)
  values (p_organization_id, v_actor, 'member.role_changed', 'member', p_user_id::text,
    jsonb_build_object('from', v_current, 'to', p_role));
end;
$$;

-- Leaving as the only admin: say what to do instead of just refusing.
create or replace function public.remove_organization_member(p_organization_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_role public.organization_role;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  perform 1 from public.organizations where id = p_organization_id and deleted_at is null for update;
  if not found then
    raise exception 'Organization not found' using errcode = '22023';
  end if;
  if v_actor <> p_user_id
    and not public.has_org_role(p_organization_id, array['admin']::public.organization_role[]) then
    raise exception 'Only organization admins can remove members' using errcode = '42501';
  end if;

  select role into v_role
  from public.organization_members
  where organization_id = p_organization_id and user_id = p_user_id and status = 'active'
  for update;
  if not found then
    raise exception 'That person is not an active member' using errcode = '22023';
  end if;
  if v_role = 'admin' and not exists (
    select 1 from public.organization_members
    where organization_id = p_organization_id and status = 'active' and role = 'admin' and user_id <> p_user_id
  ) then
    raise exception 'You are the only admin. Make someone else an admin first (transfer ownership), then leave.' using errcode = '22023';
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
