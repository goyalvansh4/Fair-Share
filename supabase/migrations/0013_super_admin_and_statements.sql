-- 1) Super admin: platform admins act as an admin of every organization, but only while "elevated".
-- Platform admins are provisioned only by a trusted operator (see README); there is no self-promotion path.
-- Elevation is a short, database-stored grant. It can be created only by the server (service role) after the
-- admin console password was verified, so a stolen ordinary session of a platform admin gains nothing.
create table public.admin_elevations (
  user_id uuid primary key references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  granted_at timestamptz not null default now()
);
alter table public.admin_elevations enable row level security;
-- No policies: the table is reachable only through the security-definer functions below.

create table public.admin_unlock_attempts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  failures integer not null default 0,
  locked_until timestamptz
);
alter table public.admin_unlock_attempts enable row level security;

-- Is this account a platform admin at all (regardless of elevation)? Used to decide whether /admin exists for them.
create or replace function public.is_platform_admin_account()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.platform_admins pa where pa.user_id = (select auth.uid()));
$$;

-- Does the caller currently hold super-admin powers? Row-level security and every RPC use this.
create or replace function public.is_platform_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.platform_admins pa
    join public.admin_elevations e on e.user_id = pa.user_id
    where pa.user_id = (select auth.uid()) and e.expires_at > now()
  );
$$;

create or replace function public.admin_elevation_expires()
returns timestamptz language sql stable security definer set search_path = '' as $$
  select e.expires_at from public.admin_elevations e
  where e.user_id = (select auth.uid()) and e.expires_at > now();
$$;

-- Server-only (service role): throttling and elevation. Never callable with a user session.
create or replace function public.admin_unlock_status(p_user_id uuid)
returns timestamptz language sql stable security definer set search_path = '' as $$
  select a.locked_until from public.admin_unlock_attempts a
  where a.user_id = p_user_id and a.locked_until > now();
$$;

create or replace function public.admin_unlock_record(p_user_id uuid, p_success boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_failures integer;
begin
  if p_success then
    delete from public.admin_unlock_attempts where user_id = p_user_id;
    return;
  end if;
  insert into public.admin_unlock_attempts (user_id, failures) values (p_user_id, 1)
  on conflict (user_id) do update set failures = public.admin_unlock_attempts.failures + 1
  returning failures into v_failures;
  -- 5 wrong passwords lock the console for 5 minutes, doubling on every further failure (max 24 hours).
  if v_failures >= 5 then
    update public.admin_unlock_attempts
    set locked_until = now() + least(interval '24 hours', interval '5 minutes' * power(2, least(v_failures - 5, 10)))
    where user_id = p_user_id;
  end if;
end;
$$;

create or replace function public.grant_admin_elevation(p_user_id uuid, p_minutes integer)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare
  v_expires timestamptz;
begin
  if not exists (select 1 from public.platform_admins where user_id = p_user_id) then
    raise exception 'Not a platform admin' using errcode = '42501';
  end if;
  v_expires := now() + make_interval(mins => least(greatest(coalesce(p_minutes, 30), 1), 120));
  insert into public.admin_elevations (user_id, expires_at) values (p_user_id, v_expires)
  on conflict (user_id) do update set expires_at = excluded.expires_at, granted_at = now();
  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, details)
  values (null, p_user_id, 'platform_admin.elevated', 'user', p_user_id::text, jsonb_build_object('expires_at', v_expires));
  return v_expires;
end;
$$;

create or replace function public.revoke_admin_elevation(p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from public.admin_elevations where user_id = p_user_id;
  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, details)
  values (null, p_user_id, 'platform_admin.locked', 'user', p_user_id::text, '{}'::jsonb);
end;
$$;

revoke all on function public.is_platform_admin_account() from public;
revoke all on function public.admin_elevation_expires() from public;
revoke all on function public.admin_unlock_status(uuid) from public;
revoke all on function public.admin_unlock_record(uuid, boolean) from public;
revoke all on function public.grant_admin_elevation(uuid, integer) from public;
revoke all on function public.revoke_admin_elevation(uuid) from public;
grant execute on function public.is_platform_admin_account() to authenticated;
grant execute on function public.admin_elevation_expires() to authenticated;
grant execute on function public.admin_unlock_status(uuid) to service_role;
grant execute on function public.admin_unlock_record(uuid, boolean) to service_role;
grant execute on function public.grant_admin_elevation(uuid, integer) to service_role;
grant execute on function public.revoke_admin_elevation(uuid) to service_role;

-- has_org_role feeds row-level security and every audited RPC: an elevated platform admin acts as admin everywhere,
-- and every write still records the real actor in audit_logs.
create or replace function public.has_org_role(p_organization_id uuid, p_roles public.organization_role[])
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_platform_admin() or exists (
    select 1 from public.organization_members m
    where m.organization_id = p_organization_id and m.user_id = (select auth.uid())
      and m.status = 'active' and m.role = any(p_roles)
  );
$$;

-- Platform admins can read member names in organizations they are not part of.
drop policy if exists "profiles_read_self_or_shared_org" on public.profiles;
create policy "profiles_read_self_or_shared_org" on public.profiles for select to authenticated
using (
  id = (select auth.uid())
  or public.is_platform_admin()
  or exists (
    select 1 from public.organization_members mine
    join public.organization_members theirs on theirs.organization_id = mine.organization_id
    where mine.user_id = (select auth.uid()) and mine.status = 'active'
      and theirs.user_id = profiles.id and theirs.status = 'active'
  )
);

-- 2) Monthly statements: per-organization email settings, edited by admins through an audited function.
create table public.statement_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  enabled boolean not null default false,
  day_of_month integer not null default 1 check (day_of_month between 1 and 28),
  recipients_mode text not null default 'admins' check (recipients_mode in ('all_members', 'admins', 'extra_only')),
  extra_emails text[] not null default '{}' check (cardinality(extra_emails) <= 20),
  last_sent_period text check (last_sent_period is null or last_sent_period ~ '^[0-9]{4}-[0-9]{2}$'),
  last_sent_at timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 500),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table public.statement_settings enable row level security;

create policy "admins_read_statement_settings" on public.statement_settings for select to authenticated
using (public.has_org_role(organization_id, array['admin']::public.organization_role[]));
-- No client insert/update/delete policies: settings change only through save_statement_settings.

create or replace function public.save_statement_settings(
  p_organization_id uuid,
  p_enabled boolean,
  p_day_of_month integer,
  p_recipients_mode text,
  p_extra_emails text[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_emails text[];
  v_email text;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  perform 1 from public.organizations where id = p_organization_id and deleted_at is null;
  if not found then
    raise exception 'Organization not found' using errcode = '22023';
  end if;
  if not public.has_org_role(p_organization_id, array['admin']::public.organization_role[]) then
    raise exception 'Only organization admins can change statement settings' using errcode = '42501';
  end if;
  if p_day_of_month is null or p_day_of_month not between 1 and 28 then
    raise exception 'Choose a day between 1 and 28' using errcode = '22023';
  end if;
  if p_recipients_mode is null or p_recipients_mode not in ('all_members', 'admins', 'extra_only') then
    raise exception 'Choose who receives the statement' using errcode = '22023';
  end if;

  select coalesce(array_agg(distinct lower(trim(e))), '{}') into v_emails
  from unnest(coalesce(p_extra_emails, '{}')) as e
  where trim(e) <> '';
  if cardinality(v_emails) > 20 then
    raise exception 'You can add up to 20 extra email addresses' using errcode = '22023';
  end if;
  foreach v_email in array v_emails loop
    if v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or char_length(v_email) > 254 then
      raise exception 'Invalid email address: %', v_email using errcode = '22023';
    end if;
  end loop;
  if p_recipients_mode = 'extra_only' and cardinality(v_emails) = 0 and p_enabled then
    raise exception 'Add at least one email address, or choose another recipient option' using errcode = '22023';
  end if;

  insert into public.statement_settings (organization_id, enabled, day_of_month, recipients_mode, extra_emails, updated_by)
  values (p_organization_id, p_enabled, p_day_of_month, p_recipients_mode, v_emails, v_actor)
  on conflict (organization_id) do update
    set enabled = excluded.enabled,
        day_of_month = excluded.day_of_month,
        recipients_mode = excluded.recipients_mode,
        extra_emails = excluded.extra_emails,
        updated_by = excluded.updated_by,
        updated_at = now();

  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, details)
  values (p_organization_id, v_actor, 'statement.settings_updated', 'organization', p_organization_id::text,
    jsonb_build_object('enabled', p_enabled, 'day_of_month', p_day_of_month, 'recipients_mode', p_recipients_mode,
      'extra_email_count', cardinality(v_emails)));
end;
$$;

-- Member email addresses for statements. Only admins (including platform admins) and the scheduled job may read them.
create or replace function public.statement_recipient_emails(p_organization_id uuid)
returns table (member_id uuid, email text, member_role public.organization_role)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.role()) is distinct from 'service_role'
    and not public.has_org_role(p_organization_id, array['admin']::public.organization_role[]) then
    raise exception 'Only organization admins can read statement recipients' using errcode = '42501';
  end if;
  return query
    select m.user_id, lower(u.email::text), m.role
    from public.organization_members m
    join auth.users u on u.id = m.user_id
    where m.organization_id = p_organization_id and m.status = 'active' and u.email is not null;
end;
$$;

revoke all on function public.save_statement_settings(uuid, boolean, integer, text, text[]) from public;
revoke all on function public.statement_recipient_emails(uuid) from public;
grant execute on function public.save_statement_settings(uuid, boolean, integer, text, text[]) to authenticated;
grant execute on function public.statement_recipient_emails(uuid) to authenticated, service_role;
