-- FairShare foundation: multi-tenant organizations, memberships, and database-enforced access.
-- Apply through Supabase migrations after reviewing in a development project.
create extension if not exists pgcrypto;

create type public.organization_type as enum ('trip', 'room', 'party', 'personal', 'custom');
create type public.organization_status as enum ('active', 'archived', 'suspended');
create type public.organization_role as enum ('admin', 'member', 'viewer');
create type public.membership_status as enum ('active', 'invited', 'removed');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 100),
  avatar_url text check (avatar_url is null or char_length(avatar_url) <= 2048),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 2 and 80),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) between 2 and 70),
  description text check (description is null or char_length(description) <= 1000),
  type public.organization_type not null default 'custom',
  currency char(3) not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
  timezone text not null default 'Asia/Kolkata',
  starts_on date,
  ends_on date,
  status public.organization_status not null default 'active',
  created_by uuid not null references auth.users(id) on delete restrict,
  deleted_at timestamptz,
  deleted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organization_dates_valid check (starts_on is null or ends_on is null or ends_on >= starts_on)
);
create index organizations_created_by_idx on public.organizations(created_by);
create index organizations_status_idx on public.organizations(status) where deleted_at is null;

create table public.organization_members (
  organization_id uuid not null references public.organizations(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete restrict,
  role public.organization_role not null default 'member',
  status public.membership_status not null default 'active',
  joined_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);
create index organization_members_user_idx on public.organization_members(user_id, status);

-- Platform admins are provisioned only by a trusted database operator/migration.
-- No authenticated client write policy is intentionally provided.
create table public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  reason text not null default 'manual provisioning' check (char_length(reason) <= 500)
);

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
create trigger profiles_set_updated_at before update on public.profiles for each row execute function public.set_updated_at();
create trigger organizations_set_updated_at before update on public.organizations for each row execute function public.set_updated_at();
create trigger organization_members_set_updated_at before update on public.organization_members for each row execute function public.set_updated_at();

create or replace function public.is_platform_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.platform_admins pa where pa.user_id = (select auth.uid()));
$$;

create or replace function public.is_org_member(p_organization_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.organization_members m
    where m.organization_id = p_organization_id and m.user_id = (select auth.uid()) and m.status = 'active'
  );
$$;

create or replace function public.has_org_role(p_organization_id uuid, p_roles public.organization_role[])
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.organization_members m
    where m.organization_id = p_organization_id and m.user_id = (select auth.uid())
      and m.status = 'active' and m.role = any(p_roles)
  );
$$;

revoke all on function public.is_platform_admin() from public;
revoke all on function public.is_org_member(uuid) from public;
revoke all on function public.has_org_role(uuid, public.organization_role[]) from public;
grant execute on function public.is_platform_admin() to authenticated;
grant execute on function public.is_org_member(uuid) to authenticated;
grant execute on function public.has_org_role(uuid, public.organization_role[]) to authenticated;

-- Organization creation and creator-admin membership are atomic through this trigger.
create or replace function public.add_organization_creator_as_admin()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null or new.created_by <> (select auth.uid()) then
    raise exception 'Organization creator must be the authenticated user' using errcode = '42501';
  end if;
  insert into public.organization_members (organization_id, user_id, role, status, joined_at)
  values (new.id, new.created_by, 'admin', 'active', now());
  return new;
end;
$$;
create trigger organizations_add_creator_admin after insert on public.organizations for each row execute function public.add_organization_creator_as_admin();

-- Create a profile for each newly registered auth user. Display name is user-editable later.
create or replace function public.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), split_part(coalesce(new.email, 'member'), '@', 1)))
  on conflict (id) do nothing;
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_auth_user();

alter table public.profiles enable row level security;
alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.platform_admins enable row level security;

create policy "profiles_read_self_or_shared_org" on public.profiles for select to authenticated
using (id = (select auth.uid()) or exists (
  select 1 from public.organization_members mine
  join public.organization_members theirs on theirs.organization_id = mine.organization_id
  where mine.user_id = (select auth.uid()) and mine.status = 'active'
    and theirs.user_id = profiles.id and theirs.status = 'active'
));
create policy "profiles_update_self" on public.profiles for update to authenticated
using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy "organizations_read_members" on public.organizations for select to authenticated
using ((public.is_org_member(id) and deleted_at is null) or public.is_platform_admin());
create policy "organizations_create_self" on public.organizations for insert to authenticated
with check (created_by = (select auth.uid()) and status = 'active' and deleted_at is null);
create policy "organizations_admin_update" on public.organizations for update to authenticated
using (public.has_org_role(id, array['admin']::public.organization_role[]) or public.is_platform_admin())
with check (public.has_org_role(id, array['admin']::public.organization_role[]) or public.is_platform_admin());
-- No direct delete policy: archive/soft-delete should be implemented as audited server-side operations.

create policy "members_read_same_org" on public.organization_members for select to authenticated
using (public.is_org_member(organization_id) or public.is_platform_admin());
create policy "admins_add_members" on public.organization_members for insert to authenticated
with check (
  (public.has_org_role(organization_id, array['admin']::public.organization_role[])
   and role <> 'admin' and status in ('invited', 'active'))
  or public.is_platform_admin()
);
create policy "admins_update_members" on public.organization_members for update to authenticated
using (public.has_org_role(organization_id, array['admin']::public.organization_role[]) or public.is_platform_admin())
with check (
  public.is_platform_admin()
  or (public.has_org_role(organization_id, array['admin']::public.organization_role[])
      and role <> 'admin' and status in ('invited', 'active', 'removed'))
);
-- Membership deletion is intentionally disabled; use status='removed' with an audit trail.

create policy "platform_admins_read_self_or_admin" on public.platform_admins for select to authenticated
using (user_id = (select auth.uid()) or public.is_platform_admin());
-- Intentionally no INSERT, UPDATE or DELETE policies for platform_admins.
