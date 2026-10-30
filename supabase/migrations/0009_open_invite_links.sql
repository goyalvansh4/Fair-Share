-- Open invite links: an admin shares one link per role; anyone who signs in with it joins with that role.
-- An open invitation has no email. It stays valid for 7 days (or until replaced) and can be used many times.
alter table public.organization_invitations alter column email drop not null;

create or replace function public.create_organization_invite_link(
  p_organization_id uuid,
  p_role public.organization_role,
  p_token_hash text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invitation_id uuid;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if not public.has_org_role(p_organization_id, array['admin']::public.organization_role[]) then
    raise exception 'Only organization admins can create invite links' using errcode = '42501';
  end if;
  if p_role is null or p_role not in ('member', 'viewer') or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid invitation details' using errcode = '22023';
  end if;

  perform 1 from public.organizations where id = p_organization_id and deleted_at is null and status = 'active' for update;
  if not found then
    raise exception 'Organization not found' using errcode = '22023';
  end if;

  -- One live link per organization and role: creating a new one replaces the old link.
  update public.organization_invitations
  set revoked_at = now()
  where organization_id = p_organization_id and email is null and role = p_role
    and accepted_at is null and revoked_at is null and expires_at > now();

  insert into public.organization_invitations (organization_id, email, role, token_hash, created_by, expires_at)
  values (p_organization_id, null, p_role, p_token_hash, (select auth.uid()), now() + interval '7 days')
  returning id into v_invitation_id;

  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, details)
  values (p_organization_id, (select auth.uid()), 'member.invite_link_created', 'invitation', v_invitation_id::text,
    jsonb_build_object('role', p_role));

  return v_invitation_id;
end;
$$;

create or replace function public.accept_organization_invitation(p_token_hash text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invitation public.organization_invitations%rowtype;
  v_email text;
  v_slug text;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid invitation token' using errcode = '22023';
  end if;

  select * into v_invitation
  from public.organization_invitations i
  where i.token_hash = p_token_hash
  for update;
  if not found or v_invitation.accepted_at is not null or v_invitation.revoked_at is not null
    or v_invitation.expires_at <= now() then
    raise exception 'Invitation is invalid or expired' using errcode = '22023';
  end if;

  -- Email-bound invitations still require the matching verified email.
  if v_invitation.email is not null then
    select lower(u.email) into v_email
    from auth.users u
    where u.id = (select auth.uid()) and u.email_confirmed_at is not null;
    if v_email is null then
      raise exception 'A verified email address is required' using errcode = '42501';
    end if;
    if lower(v_invitation.email) <> v_email then
      raise exception 'Sign in using the email address this invitation was sent to' using errcode = '42501';
    end if;
  end if;

  select o.slug into v_slug
  from public.organizations o
  where o.id = v_invitation.organization_id and o.deleted_at is null and o.status = 'active';
  if v_slug is null then
    raise exception 'Organization is no longer available' using errcode = '22023';
  end if;

  insert into public.organization_members (organization_id, user_id, role, status, joined_at)
  values (v_invitation.organization_id, (select auth.uid()), v_invitation.role, 'active', now())
  on conflict (organization_id, user_id) do update
    set role = excluded.role, status = 'active', joined_at = now(), updated_at = now()
    where public.organization_members.status in ('invited', 'removed');
  if not found then
    raise exception 'You are already a member of this organization' using errcode = '23505';
  end if;

  -- Open links stay valid for further members; email invitations are single use.
  if v_invitation.email is not null then
    update public.organization_invitations set accepted_at = now() where id = v_invitation.id;
  end if;
  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, details)
  values (v_invitation.organization_id, (select auth.uid()), 'member.joined', 'invitation', v_invitation.id::text,
    jsonb_build_object('role', v_invitation.role, 'via', case when v_invitation.email is null then 'link' else 'email' end));

  return v_slug;
end;
$$;

revoke all on function public.create_organization_invite_link(uuid, public.organization_role, text) from public;
grant execute on function public.create_organization_invite_link(uuid, public.organization_role, text) to authenticated;
