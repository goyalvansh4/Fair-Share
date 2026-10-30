create table public.organization_invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  email text not null check (char_length(email) between 3 and 320),
  role public.organization_role not null check (role in ('member', 'viewer')),
  token_hash char(64) not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid not null references auth.users(id) on delete restrict,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index organization_invitations_org_idx on public.organization_invitations(organization_id, created_at desc);
alter table public.organization_invitations enable row level security;

create or replace function public.create_organization_invitation(
  p_organization_id uuid,
  p_email text,
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
  v_email text := lower(trim(p_email));
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if not public.has_org_role(p_organization_id, array['admin']::public.organization_role[]) then
    raise exception 'Only organization admins can invite members' using errcode = '42501';
  end if;
  if v_email is null
    or p_token_hash is null
    or p_role is null
    or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or char_length(v_email) > 320
    or p_role not in ('member', 'viewer')
    or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid invitation details' using errcode = '22023';
  end if;

  perform 1 from public.organizations where id = p_organization_id and deleted_at is null for update;
  if not found then
    raise exception 'Organization not found' using errcode = '22023';
  end if;
  if exists (
    select 1
    from auth.users u
    join public.organization_members m on m.user_id = u.id
    where m.organization_id = p_organization_id and m.status = 'active'
      and lower(u.email) = v_email
  ) then
    raise exception 'This person is already an active member' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.organization_invitations i
    where i.organization_id = p_organization_id and i.email = v_email
      and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
  ) then
    raise exception 'An active invitation already exists for this email' using errcode = '23505';
  end if;

  insert into public.organization_invitations (organization_id, email, role, token_hash, created_by, expires_at)
  values (p_organization_id, v_email, p_role, p_token_hash, (select auth.uid()), now() + interval '7 days')
  returning id into v_invitation_id;

  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, details)
  values (p_organization_id, (select auth.uid()), 'member.invited', 'invitation', v_invitation_id::text,
    jsonb_build_object('email', v_email, 'role', p_role));

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
  select lower(u.email) into v_email
  from auth.users u
  where u.id = (select auth.uid()) and u.email_confirmed_at is not null;
  if v_email is null then
    raise exception 'A verified email address is required' using errcode = '42501';
  end if;

  select * into v_invitation
  from public.organization_invitations i
  where i.token_hash = p_token_hash
  for update;
  if not found or v_invitation.accepted_at is not null or v_invitation.revoked_at is not null
    or v_invitation.expires_at <= now() then
    raise exception 'Invitation is invalid or expired' using errcode = '22023';
  end if;
  if lower(v_invitation.email) <> v_email then
    raise exception 'Sign in using the email address this invitation was sent to' using errcode = '42501';
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

  update public.organization_invitations set accepted_at = now() where id = v_invitation.id;
  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, details)
  values (v_invitation.organization_id, (select auth.uid()), 'member.joined', 'invitation', v_invitation.id::text,
    jsonb_build_object('role', v_invitation.role));

  return v_slug;
end;
$$;

revoke all on function public.create_organization_invitation(uuid, text, public.organization_role, text) from public;
revoke all on function public.accept_organization_invitation(text) from public;
grant execute on function public.create_organization_invitation(uuid, text, public.organization_role, text) to authenticated;
grant execute on function public.accept_organization_invitation(text) to authenticated;
