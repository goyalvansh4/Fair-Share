-- Invite codes: every space has a short code (like A1B2-C3D4-E5F6) and a separate secret code (like 9F3A1-C07BD).
-- Signing in and entering both makes you a member. The invite code is meant to be passed around and will leak, so the
-- secret code is the second factor an admin hands over personally. The secret can be reset or turned off by admins.
-- Codes live in their own table with no client policies, so they are readable only through the functions below:
-- only the owner and admins of the space can see, reset or turn off the code, and anyone signed in can use it.
-- Wrong guesses are limited per person, and someone an admin removed cannot rejoin with the code.
create table public.organization_invite_codes (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  code text not null unique check (code ~ '^[0-9A-F]{12}$'),
  secret text check (secret is null or secret ~ '^[0-9A-F]{10}$'),
  updated_at timestamptz not null default now()
);
alter table public.organization_invite_codes enable row level security;

create table public.invite_code_attempts (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index invite_code_attempts_user_idx on public.invite_code_attempts(user_id, created_at desc);
alter table public.invite_code_attempts enable row level security;

create or replace function public.new_invite_code()
returns text language plpgsql volatile security definer set search_path = '' as $$
declare
  v_code text;
begin
  loop
    v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
    exit when not exists (select 1 from public.organization_invite_codes where code = v_code);
  end loop;
  return v_code;
end;
$$;
create or replace function public.new_secret_code()
returns text language sql volatile security definer set search_path = '' as $$
  select upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
$$;
revoke all on function public.new_invite_code() from public;
revoke all on function public.new_secret_code() from public;

-- Every new space gets a code; existing spaces are backfilled.
create or replace function public.create_invite_code_for_new_organization()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.organization_invite_codes (organization_id, code, secret) values (new.id, public.new_invite_code(), public.new_secret_code());
  return new;
end;
$$;
create trigger organizations_create_invite_code after insert on public.organizations
for each row execute function public.create_invite_code_for_new_organization();

insert into public.organization_invite_codes (organization_id, code, secret)
select o.id, public.new_invite_code(), public.new_secret_code() from public.organizations o
where o.deleted_at is null
on conflict (organization_id) do nothing;

-- The code and secret of a space, for its owner and admins only (both null when the invite code is turned off).
create or replace function public.get_organization_invite_details(p_organization_id uuid)
returns table (code text, secret text) language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.has_org_role(p_organization_id, array['admin']::public.organization_role[]) then
    raise exception 'Only the owner and admins can see the invite code' using errcode = '42501';
  end if;
  return query select c.code, c.secret from public.organization_invite_codes c where c.organization_id = p_organization_id;
end;
$$;

-- Admins: p_enable = true makes a fresh code (the old one stops working); false turns the code off.
create or replace function public.rotate_organization_invite_code(p_organization_id uuid, p_enable boolean default true)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_code text;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  perform 1 from public.organizations where id = p_organization_id and deleted_at is null for update;
  if not found then
    raise exception 'Organization not found' using errcode = '22023';
  end if;
  if not public.has_org_role(p_organization_id, array['admin']::public.organization_role[]) then
    raise exception 'Only organization admins can change the invite code' using errcode = '42501';
  end if;
  if coalesce(p_enable, true) then
    v_code := public.new_invite_code();
    insert into public.organization_invite_codes (organization_id, code, secret) values (p_organization_id, v_code, public.new_secret_code())
    on conflict (organization_id) do update set code = excluded.code, updated_at = now();
  else
    delete from public.organization_invite_codes where organization_id = p_organization_id;
  end if;
  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, details)
  values (p_organization_id, v_actor, case when v_code is null then 'invite_code.disabled' else 'invite_code.rotated' end,
    'organization', p_organization_id::text, '{}'::jsonb);
  return v_code;
end;
$$;

-- Admins: p_enable = true makes a fresh secret code; false turns the secret off (the invite code alone then admits people).
create or replace function public.rotate_organization_secret_code(p_organization_id uuid, p_enable boolean default true)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_secret text;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  perform 1 from public.organizations where id = p_organization_id and deleted_at is null for update;
  if not found then
    raise exception 'Organization not found' using errcode = '22023';
  end if;
  if not public.has_org_role(p_organization_id, array['admin']::public.organization_role[]) then
    raise exception 'Only organization admins can change the secret code' using errcode = '42501';
  end if;
  if not exists (select 1 from public.organization_invite_codes where organization_id = p_organization_id) then
    raise exception 'Turn on the invite code first.' using errcode = '22023';
  end if;
  v_secret := case when coalesce(p_enable, true) then public.new_secret_code() else null end;
  update public.organization_invite_codes set secret = v_secret, updated_at = now() where organization_id = p_organization_id;
  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, details)
  values (p_organization_id, v_actor, case when v_secret is null then 'secret_code.disabled' else 'secret_code.rotated' end,
    'organization', p_organization_id::text, '{}'::jsonb);
  return v_secret;
end;
$$;

-- Join a space with its code. The new member starts sharing group expenses from today (space timezone).
create or replace function public.join_organization_by_code(p_code text, p_secret text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '[^0-9A-Za-z]', '', 'g'));
  v_secret_input text := upper(regexp_replace(coalesce(p_secret, ''), '[^0-9A-Za-z]', '', 'g'));
  v_secret text;
  v_organization_id uuid;
  v_slug text;
  v_timezone text;
  v_status public.membership_status;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if (select count(*) from public.invite_code_attempts a where a.user_id = v_actor and a.created_at > now() - interval '1 hour') >= 10 then
    raise exception 'Too many wrong codes. Please try again in an hour.' using errcode = '54000';
  end if;

  select c.organization_id, o.slug, o.timezone, c.secret into v_organization_id, v_slug, v_timezone, v_secret
  from public.organization_invite_codes c
  join public.organizations o on o.id = c.organization_id
  where c.code = v_code and v_code ~ '^[0-9A-F]{12}$'
    and o.deleted_at is null and o.status = 'active';
  -- One generic message for a wrong code or a wrong/missing secret, so neither can be guessed separately.
  if v_organization_id is null or (v_secret is not null and v_secret is distinct from v_secret_input) then
    insert into public.invite_code_attempts (user_id) values (v_actor);
    raise exception 'That invite code or secret code is not valid. Check both and try again.' using errcode = '22023';
  end if;

  perform 1 from public.organizations where id = v_organization_id for update;
  select m.status into v_status from public.organization_members m
  where m.organization_id = v_organization_id and m.user_id = v_actor;
  if v_status = 'active' then
    raise exception 'You are already a member of this space.' using errcode = '23505';
  end if;
  if v_status = 'removed' then
    raise exception 'You were removed from this space. Ask an admin for a new invitation.' using errcode = '42501';
  end if;

  insert into public.organization_members (organization_id, user_id, role, status, joined_at, share_from)
  values (v_organization_id, v_actor, 'member', 'active', now(), (now() at time zone coalesce(v_timezone, 'UTC'))::date)
  on conflict (organization_id, user_id) do update
    set role = 'member', status = 'active', joined_at = now(), updated_at = now();

  perform public.resplit_group_expenses(v_organization_id);

  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, details)
  values (v_organization_id, v_actor, 'member.joined', 'organization', v_organization_id::text,
    jsonb_build_object('role', 'member', 'via', 'code'));
  return v_slug;
end;
$$;

revoke all on function public.get_organization_invite_details(uuid) from public;
revoke all on function public.rotate_organization_secret_code(uuid, boolean) from public;
revoke all on function public.rotate_organization_invite_code(uuid, boolean) from public;
revoke all on function public.join_organization_by_code(text, text) from public;
grant execute on function public.get_organization_invite_details(uuid) to authenticated;
grant execute on function public.rotate_organization_secret_code(uuid, boolean) to authenticated;
grant execute on function public.rotate_organization_invite_code(uuid, boolean) to authenticated;
grant execute on function public.join_organization_by_code(text, text) to authenticated;
