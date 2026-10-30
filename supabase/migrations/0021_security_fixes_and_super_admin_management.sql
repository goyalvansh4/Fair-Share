-- 0021: security fixes from an independent review, plus the final form of the invite/secret-code and super-admin rules.
-- Everything here is written as create-or-replace / if-not-exists, so it is safe on a database that already has an
-- earlier version of these objects.
--
-- Money:  viewers cannot record transfers; a recipient can reject a transfer; expense creation locks the space first
--         and checks currency and status in the database; a removed member cannot come back through an open link.
-- Races:  per-person advisory locks make the one-admin-per-person rule and the invite-code attempt limit atomic;
--         admin-console password attempts are counted before the password is checked.
-- Rules:  the invite code is visible to every member; the secret code (and inviting/resetting) belongs to the real
--         owner and admins only, never to a super admin; a super admin can read, edit, archive and delete spaces.


-- A) a timezone that does not exist would make every join fail
create or replace function public.is_valid_timezone(p_timezone text)
returns boolean language plpgsql stable set search_path = '' as $$
begin
  perform now() at time zone p_timezone;
  return true;
exception when others then
  return false;
end;
$$;
revoke all on function public.is_valid_timezone(text) from public, anon;
grant execute on function public.is_valid_timezone(text) to authenticated;
alter table public.organizations drop constraint if exists organizations_timezone_valid;
alter table public.organizations add constraint organizations_timezone_valid check (public.is_valid_timezone(timezone)) not valid;
alter table public.profiles drop constraint if exists profiles_avatar_url_https;
alter table public.profiles add constraint profiles_avatar_url_https check (avatar_url is null or avatar_url ~ '^https://') not valid;


-- Internal helper: is the caller an active admin MEMBER of the space? Unlike has_org_role it ignores super-admin elevation.
create or replace function public.is_org_admin_member(p_organization_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.organization_members m
    where m.organization_id = p_organization_id and m.user_id = (select auth.uid())
      and m.status = 'active' and m.role = 'admin'
  );
$$;
revoke all on function public.is_org_admin_member(uuid) from public, anon, authenticated;


-- B) expenses
create or replace function public.create_expense_with_splits(
  p_organization_id uuid,
  p_title text,
  p_description text,
  p_amount_minor bigint,
  p_currency char(3),
  p_expense_date date,
  p_payer_id uuid,
  p_category public.expense_category,
  p_split_method public.split_method,
  p_splits jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_expense_id uuid;
  v_split_sum numeric;
  v_split_count integer;
  v_member_count integer;
  v_org_currency char(3);
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if not public.has_org_role(p_organization_id, array['admin','member']::public.organization_role[]) then
    raise exception 'Not authorized for this organization' using errcode = '42501';
  end if;
  -- Lock the space before validating, so a concurrent member removal cannot slip in between check and insert.
  select o.currency into v_org_currency from public.organizations o
  where o.id = p_organization_id and o.deleted_at is null and o.status = 'active'
  for update;
  if not found then
    raise exception 'Organization not found or inactive' using errcode = '22023';
  end if;
  if p_currency is distinct from v_org_currency then
    raise exception 'Expense currency must match the space currency' using errcode = '22023';
  end if;
  if p_title is null or char_length(trim(p_title)) not between 1 and 140 then
    raise exception 'Invalid expense title' using errcode = '22023';
  end if;
  if p_amount_minor is null or p_amount_minor <= 0 then
    raise exception 'Amount must be positive' using errcode = '22023';
  end if;
  if p_currency !~ '^[A-Z]{3}$' then
    raise exception 'Invalid currency' using errcode = '22023';
  end if;
  if p_payer_id is null or not exists (
    select 1 from public.organization_members m where m.organization_id = p_organization_id
      and m.user_id = p_payer_id and m.status = 'active'
  ) then
    raise exception 'Payer must be an active organization member' using errcode = '22023';
  end if;
  if jsonb_typeof(p_splits) <> 'array' or jsonb_array_length(p_splits) = 0 then
    raise exception 'At least one split is required' using errcode = '22023';
  end if;
  select sum((s.value ->> 'amount_minor')::bigint), count(*), count(distinct (s.value ->> 'member_id')::uuid)
    into v_split_sum, v_split_count, v_member_count
  from jsonb_array_elements(p_splits) as s(value);
  if v_split_count <> v_member_count then
    raise exception 'Duplicate split participant' using errcode = '22023';
  end if;
  if v_split_sum <> p_amount_minor then
    raise exception 'Expense total must equal split total' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_splits) as s(value)
    left join public.organization_members m on m.organization_id = p_organization_id
      and m.user_id = (s.value ->> 'member_id')::uuid and m.status = 'active'
    where m.user_id is null or (s.value ->> 'amount_minor') is null
      or (s.value ->> 'amount_minor')::bigint < 0
  ) then
    raise exception 'Each split must reference an active member and a non-negative amount' using errcode = '22023';
  end if;

  insert into public.expenses (organization_id, title, description, amount_minor, currency, expense_date, payer_id, category, split_method, created_by)
  values (p_organization_id, trim(p_title), nullif(trim(p_description), ''), p_amount_minor, p_currency, p_expense_date, p_payer_id, p_category, p_split_method, (select auth.uid()))
  returning id into v_expense_id;

  insert into public.expense_splits (expense_id, organization_id, member_id, amount_minor)
  select v_expense_id, p_organization_id, (s.value ->> 'member_id')::uuid, (s.value ->> 'amount_minor')::bigint
  from jsonb_array_elements(p_splits) as s(value);

  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, details)
  values (p_organization_id, (select auth.uid()), 'expense.created', 'expense', v_expense_id::text,
    jsonb_build_object('amount_minor', p_amount_minor, 'currency', p_currency, 'split_count', v_split_count));

  return v_expense_id;
end;
$$;

create or replace function public.create_group_expense(
  p_organization_id uuid,
  p_title text,
  p_description text,
  p_amount_minor bigint,
  p_currency char(3),
  p_expense_date date,
  p_payer_id uuid,
  p_category public.expense_category
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_expense_id uuid;
  v_org_currency char(3);
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  select o.currency into v_org_currency from public.organizations o
  where o.id = p_organization_id and o.deleted_at is null and o.status = 'active'
  for update;
  if not found then
    raise exception 'Organization not found or inactive' using errcode = '22023';
  end if;
  if p_currency is distinct from v_org_currency then
    raise exception 'Expense currency must match the space currency' using errcode = '22023';
  end if;
  if not public.has_org_role(p_organization_id, array['admin','member']::public.organization_role[]) then
    raise exception 'Not authorized for this organization' using errcode = '42501';
  end if;
  if p_title is null or char_length(trim(p_title)) not between 1 and 140 then
    raise exception 'Invalid expense title' using errcode = '22023';
  end if;
  if p_amount_minor is null or p_amount_minor <= 0 then
    raise exception 'Amount must be positive' using errcode = '22023';
  end if;
  if p_currency !~ '^[A-Z]{3}$' then
    raise exception 'Invalid currency' using errcode = '22023';
  end if;
  if p_payer_id is null or not exists (
    select 1 from public.organization_members m where m.organization_id = p_organization_id
      and m.user_id = p_payer_id and m.status = 'active'
  ) then
    raise exception 'The payer must be an active member' using errcode = '22023';
  end if;

  insert into public.expenses (organization_id, title, description, amount_minor, currency, expense_date, payer_id, category, split_method, split_scope, created_by)
  values (p_organization_id, trim(p_title), nullif(trim(coalesce(p_description, '')), ''), p_amount_minor, p_currency, p_expense_date, p_payer_id, p_category, 'equal', 'group', v_actor)
  returning id into v_expense_id;

  perform public.apply_group_split(v_expense_id);

  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, details)
  values (p_organization_id, v_actor, 'expense.created', 'expense', v_expense_id::text,
    jsonb_build_object('amount_minor', p_amount_minor, 'currency', p_currency, 'scope', 'group'));

  return v_expense_id;
end;
$$;


-- D) a viewer cannot record a transfer
create or replace function public.record_settlement(
  p_organization_id uuid,
  p_from_member_id uuid,
  p_to_member_id uuid,
  p_amount_minor bigint,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settlement_id uuid;
  v_currency char(3);
  v_from_balance numeric;
  v_to_balance numeric;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_from_member_id = p_to_member_id or p_amount_minor is null or p_amount_minor <= 0 then
    raise exception 'Invalid settlement participants or amount' using errcode = '22023';
  end if;
  if p_note is not null and char_length(p_note) > 1000 then
    raise exception 'Settlement note is too long' using errcode = '22023';
  end if;
  if not public.has_org_role(p_organization_id, array['admin', 'member']::public.organization_role[]) then
    raise exception 'Viewers cannot record transfers' using errcode = '42501';
  end if;
  if (select auth.uid()) <> p_from_member_id
    and not public.has_org_role(p_organization_id, array['admin']::public.organization_role[]) then
    raise exception 'Only the sender or an organization admin can record this transfer' using errcode = '42501';
  end if;

  select o.currency into v_currency
  from public.organizations o
  where o.id = p_organization_id and o.status = 'active' and o.deleted_at is null
  for update;
  if not found then
    raise exception 'Organization not found or inactive' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.organization_members m
    where m.organization_id = p_organization_id and m.user_id = p_from_member_id and m.status = 'active'
  ) or not exists (
    select 1 from public.organization_members m
    where m.organization_id = p_organization_id and m.user_id = p_to_member_id and m.status = 'active'
  ) then
    raise exception 'Settlement participants must be active members' using errcode = '22023';
  end if;

  select
    coalesce((select sum(e.amount_minor) from public.expenses e where e.organization_id = p_organization_id and e.payer_id = p_from_member_id and e.status = 'active' and e.deleted_at is null), 0)
    - coalesce((select sum(s.amount_minor) from public.expense_splits s join public.expenses e on e.id = s.expense_id and e.organization_id = s.organization_id where s.organization_id = p_organization_id and s.member_id = p_from_member_id and e.status = 'active' and e.deleted_at is null), 0)
    + coalesce((select sum(st.amount_minor) from public.settlements st where st.organization_id = p_organization_id and st.from_member_id = p_from_member_id and st.status in ('pending', 'confirmed')), 0)
    - coalesce((select sum(st.amount_minor) from public.settlements st where st.organization_id = p_organization_id and st.to_member_id = p_from_member_id and st.status in ('pending', 'confirmed')), 0)
  into v_from_balance;

  select
    coalesce((select sum(e.amount_minor) from public.expenses e where e.organization_id = p_organization_id and e.payer_id = p_to_member_id and e.status = 'active' and e.deleted_at is null), 0)
    - coalesce((select sum(s.amount_minor) from public.expense_splits s join public.expenses e on e.id = s.expense_id and e.organization_id = s.organization_id where s.organization_id = p_organization_id and s.member_id = p_to_member_id and e.status = 'active' and e.deleted_at is null), 0)
    + coalesce((select sum(st.amount_minor) from public.settlements st where st.organization_id = p_organization_id and st.from_member_id = p_to_member_id and st.status in ('pending', 'confirmed')), 0)
    - coalesce((select sum(st.amount_minor) from public.settlements st where st.organization_id = p_organization_id and st.to_member_id = p_to_member_id and st.status in ('pending', 'confirmed')), 0)
  into v_to_balance;

  if v_from_balance >= 0 or v_to_balance <= 0
    or p_amount_minor > least(abs(v_from_balance), v_to_balance) then
    raise exception 'Transfer exceeds the current amount owed between these members' using errcode = '22023';
  end if;

  insert into public.settlements (organization_id, from_member_id, to_member_id, amount_minor, currency, note, created_by)
  values (p_organization_id, p_from_member_id, p_to_member_id, p_amount_minor, v_currency, nullif(trim(p_note), ''), (select auth.uid()))
  returning id into v_settlement_id;

  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, details)
  values (p_organization_id, (select auth.uid()), 'settlement.recorded', 'settlement', v_settlement_id::text,
    jsonb_build_object('amount_minor', p_amount_minor, 'currency', v_currency, 'from_member_id', p_from_member_id, 'to_member_id', p_to_member_id));

  return v_settlement_id;
end;
$$;


-- E) the recipient can reject
create or replace function public.resolve_settlement(p_settlement_id uuid, p_action text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settlement public.settlements%rowtype;
  v_actor uuid := (select auth.uid());
  v_status public.settlement_status;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_action not in ('confirm', 'cancel') then
    raise exception 'Invalid settlement action' using errcode = '22023';
  end if;

  select * into v_settlement
  from public.settlements
  where id = p_settlement_id
  for update;
  if not found then
    raise exception 'Settlement not found' using errcode = '22023';
  end if;
  perform 1 from public.organizations where id = v_settlement.organization_id for update;
  if v_settlement.status <> 'pending' then
    raise exception 'Only pending settlements can be resolved' using errcode = '22023';
  end if;
  if p_action = 'confirm' then
    if v_actor <> v_settlement.to_member_id
      and not public.has_org_role(v_settlement.organization_id, array['admin']::public.organization_role[]) then
      raise exception 'Only the recipient or an organization admin can confirm this transfer' using errcode = '42501';
    end if;
    v_status := 'confirmed';
  else
    -- The recipient can reject a transfer they never received; otherwise a debtor could clear a debt alone.
    if v_actor <> v_settlement.from_member_id
      and v_actor <> v_settlement.to_member_id
      and not public.has_org_role(v_settlement.organization_id, array['admin']::public.organization_role[]) then
      raise exception 'Only the sender, the recipient or an organization admin can cancel this transfer' using errcode = '42501';
    end if;
    v_status := 'cancelled';
  end if;

  update public.settlements
  set status = v_status,
      confirmed_by = case when v_status = 'confirmed' then v_actor else confirmed_by end,
      confirmed_at = case when v_status = 'confirmed' then now() else confirmed_at end
  where id = p_settlement_id;

  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, details)
  values (v_settlement.organization_id, v_actor, 'settlement.' || p_action, 'settlement', p_settlement_id::text,
    jsonb_build_object('amount_minor', v_settlement.amount_minor, 'currency', v_settlement.currency));
end;
$$;


-- F) only real admins invite (a super admin cannot add people to someone else's space)
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
  if not public.is_org_admin_member(p_organization_id) then
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
  if not public.is_org_admin_member(p_organization_id) then
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
  v_timezone text;
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

  select o.slug, o.timezone into v_slug, v_timezone
  from public.organizations o
  where o.id = v_invitation.organization_id and o.deleted_at is null and o.status = 'active'
  for update;
  if v_slug is null then
    raise exception 'Organization is no longer available' using errcode = '22023';
  end if;

  -- A person an admin removed cannot walk back in through a reusable link.
  if v_invitation.email is null and exists (
    select 1 from public.organization_members m
    where m.organization_id = v_invitation.organization_id and m.user_id = (select auth.uid()) and m.status = 'removed'
  ) then
    raise exception 'You were removed from this space. Ask an admin for a new invitation.' using errcode = '42501';
  end if;

  insert into public.organization_members (organization_id, user_id, role, status, joined_at, share_from)
  values (v_invitation.organization_id, (select auth.uid()), v_invitation.role, 'active', now(),
    (now() at time zone coalesce(v_timezone, 'UTC'))::date)
  on conflict (organization_id, user_id) do update
    set role = excluded.role, status = 'active', joined_at = now(), updated_at = now()
    where public.organization_members.status in ('invited', 'removed');
  if not found then
    raise exception 'You are already a member of this organization' using errcode = '23505';
  end if;

  perform public.resplit_group_expenses(v_invitation.organization_id);

  if v_invitation.email is not null then
    update public.organization_invitations set accepted_at = now() where id = v_invitation.id;
  end if;
  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, details)
  values (v_invitation.organization_id, (select auth.uid()), 'member.joined', 'invitation', v_invitation.id::text,
    jsonb_build_object('role', v_invitation.role, 'via', case when v_invitation.email is null then 'link' else 'email' end));

  return v_slug;
end;
$$;


-- G) per-person locks: concurrent requests cannot make one person admin of several spaces
create or replace function public.enforce_single_admin_space_on_create()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('single-admin:' || new.created_by::text, 0));
  if public.is_admin_of_other_space(new.created_by, null) and not public.is_platform_admin() then
    raise exception 'You already manage a space. Make someone else an admin and leave it before creating another.' using errcode = '22023';
  end if;
  return new;
end;
$$;

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

  perform pg_advisory_xact_lock(hashtextextended('single-admin:' || p_user_id::text, 0));
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
  perform pg_advisory_xact_lock(hashtextextended('single-admin:' || p_new_owner_id::text, 0));
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


-- H) Admin console: the attempt is counted BEFORE the password is checked and the row is locked, so a burst of
--    parallel guesses cannot all pass the lockout check. Returns the lock expiry when the console is locked.
create or replace function public.admin_unlock_begin(p_user_id uuid)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare
  v_locked timestamptz;
  v_failures integer;
begin
  insert into public.admin_unlock_attempts (user_id, failures) values (p_user_id, 0) on conflict (user_id) do nothing;
  select a.locked_until, a.failures into v_locked, v_failures
  from public.admin_unlock_attempts a where a.user_id = p_user_id for update;
  if v_locked is not null and v_locked > now() then
    return v_locked;
  end if;
  v_failures := v_failures + 1;
  update public.admin_unlock_attempts
  set failures = v_failures,
      locked_until = case when v_failures >= 5
        then now() + least(interval '24 hours', interval '5 minutes' * power(2, least(v_failures - 5, 10)))
        else null end
  where user_id = p_user_id;
  return null;
end;
$$;
revoke all on function public.admin_unlock_begin(uuid) from public, anon, authenticated;
grant execute on function public.admin_unlock_begin(uuid) to service_role;


-- I) Invite code: visible to every member of the space. Secret code: visible and editable only by the real owner and
--    admins - never by a super admin - and rotatable or set to a custom value.
alter table public.organization_invite_codes add column if not exists secret text;
alter table public.organization_invite_codes drop constraint if exists organization_invite_codes_secret_check;
alter table public.organization_invite_codes add constraint organization_invite_codes_secret_check check (secret is null or secret ~ '^[0-9A-Z]{8,32}$');

create or replace function public.new_secret_code()
returns text language sql volatile security definer set search_path = '' as $$
  select upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
$$;
revoke all on function public.new_secret_code() from public, anon, authenticated;
update public.organization_invite_codes set secret = public.new_secret_code() where secret is null;

drop function if exists public.get_organization_invite_details(uuid);
create or replace function public.get_organization_invite_code(p_organization_id uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_org_member(p_organization_id) and not public.is_platform_admin() then
    raise exception 'Only members can see the invite code' using errcode = '42501';
  end if;
  return (select c.code from public.organization_invite_codes c where c.organization_id = p_organization_id);
end;
$$;

create or replace function public.get_organization_secret_code(p_organization_id uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_org_admin_member(p_organization_id) then
    raise exception 'Only the owner and admins can see the secret code' using errcode = '42501';
  end if;
  return (select c.secret from public.organization_invite_codes c where c.organization_id = p_organization_id);
end;
$$;

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
  if not public.is_org_admin_member(p_organization_id) then
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
  if not public.is_org_admin_member(p_organization_id) then
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


-- Set your own secret code (8-32 letters/digits, not trivially weak, different from the invite code).
create or replace function public.set_organization_secret_code(p_organization_id uuid, p_secret text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_secret text := upper(regexp_replace(coalesce(p_secret, ''), '[^0-9A-Za-z]', '', 'g'));
  v_code text;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  perform 1 from public.organizations where id = p_organization_id and deleted_at is null for update;
  if not found then
    raise exception 'Organization not found' using errcode = '22023';
  end if;
  if not public.is_org_admin_member(p_organization_id) then
    raise exception 'Only organization admins can change the secret code' using errcode = '42501';
  end if;
  if char_length(v_secret) < 8 or char_length(v_secret) > 32 then
    raise exception 'The secret code must be 8 to 32 letters or digits.' using errcode = '22023';
  end if;
  if (select count(distinct ch) from regexp_split_to_table(v_secret, '') as ch) < 4 then
    raise exception 'That secret code is too easy to guess. Use at least 4 different characters.' using errcode = '22023';
  end if;
  select c.code into v_code from public.organization_invite_codes c where c.organization_id = p_organization_id;
  if v_code is null then
    raise exception 'Turn on the invite code first.' using errcode = '22023';
  end if;
  if v_secret = v_code then
    raise exception 'The secret code must be different from the invite code.' using errcode = '22023';
  end if;
  update public.organization_invite_codes set secret = v_secret, updated_at = now() where organization_id = p_organization_id;
  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, details)
  values (p_organization_id, v_actor, 'secret_code.customized', 'organization', p_organization_id::text, '{}'::jsonb);
  return v_secret;
end;
$$;


drop function if exists public.join_organization_by_code(text);
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
  -- Serialize attempts per person so parallel requests cannot exceed the hourly limit.
  perform pg_advisory_xact_lock(hashtextextended('invite-attempts:' || v_actor::text, 0));
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


revoke all on function
  public.get_organization_invite_code(uuid), public.get_organization_secret_code(uuid),
  public.rotate_organization_invite_code(uuid, boolean), public.rotate_organization_secret_code(uuid, boolean),
  public.set_organization_secret_code(uuid, text), public.join_organization_by_code(text, text)
from public, anon;
grant execute on function
  public.get_organization_invite_code(uuid), public.get_organization_secret_code(uuid),
  public.rotate_organization_invite_code(uuid, boolean), public.rotate_organization_secret_code(uuid, boolean),
  public.set_organization_secret_code(uuid, text), public.join_organization_by_code(text, text)
to authenticated;


-- L) Super admin management of spaces: read everything (except the secret code), edit, archive, delete and restore.
--    Every function requires an unlocked admin console (is_platform_admin) and writes an audit entry. Deleting is a
--    soft delete: financial history is kept and a deleted space can be restored.
create or replace function public.admin_list_organizations(p_deleted boolean default false)
returns table (
  id uuid, name text, slug text, type text, status text, currency text, timezone text,
  created_at timestamptz, deleted_at timestamptz,
  owner_name text, owner_email text,
  member_count bigint, expense_count bigint, total_spend_minor bigint, last_activity_at timestamptz
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Admin console is locked' using errcode = '42501';
  end if;
  return query
    select o.id, o.name, o.slug, o.type::text, o.status::text, o.currency::text, o.timezone, o.created_at, o.deleted_at,
      coalesce(nullif(trim(p.display_name), ''), split_part(u.email::text, '@', 1)),
      lower(u.email::text),
      (select count(*) from public.organization_members m where m.organization_id = o.id and m.status = 'active'),
      (select count(*) from public.expenses e where e.organization_id = o.id and e.status = 'active' and e.deleted_at is null),
      (select coalesce(sum(e.amount_minor), 0)::bigint from public.expenses e where e.organization_id = o.id and e.status = 'active' and e.deleted_at is null),
      greatest(
        o.created_at,
        (select max(e.created_at) from public.expenses e where e.organization_id = o.id),
        (select max(e.updated_at) from public.expenses e where e.organization_id = o.id),
        (select max(s.created_at) from public.settlements s where s.organization_id = o.id),
        (select max(m.joined_at) from public.organization_members m where m.organization_id = o.id)
      )
    from public.organizations o
    left join auth.users u on u.id = o.owner_id
    left join public.profiles p on p.id = o.owner_id
    where (o.deleted_at is not null) = coalesce(p_deleted, false)
    order by o.created_at desc
    limit 1000;
end;
$$;

create or replace function public.admin_update_organization(
  p_organization_id uuid, p_name text, p_description text, p_type text, p_timezone text, p_status text
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
begin
  if not public.is_platform_admin() then
    raise exception 'Admin console is locked' using errcode = '42501';
  end if;
  if p_name is null or char_length(trim(p_name)) not between 2 and 80 then
    raise exception 'The name must be 2 to 80 characters' using errcode = '22023';
  end if;
  if p_description is not null and char_length(p_description) > 1000 then
    raise exception 'The description is too long' using errcode = '22023';
  end if;
  if p_type not in ('trip', 'room', 'party', 'personal', 'custom') or p_status not in ('active', 'archived', 'suspended') then
    raise exception 'Invalid type or status' using errcode = '22023';
  end if;
  if not public.is_valid_timezone(p_timezone) then
    raise exception 'Unknown timezone' using errcode = '22023';
  end if;
  update public.organizations
  set name = trim(p_name),
      description = case when p_description is null then description else nullif(trim(p_description), '') end,
      type = p_type::public.organization_type, timezone = p_timezone, status = p_status::public.organization_status
  where id = p_organization_id and deleted_at is null;
  if not found then
    raise exception 'Space not found' using errcode = '22023';
  end if;
  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, details)
  values (p_organization_id, v_actor, 'platform_admin.space_updated', 'organization', p_organization_id::text,
    jsonb_build_object('name', trim(p_name), 'status', p_status));
end;
$$;

create or replace function public.admin_delete_organizations(p_ids uuid[], p_reason text default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_id uuid;
  v_count integer := 0;
begin
  if not public.is_platform_admin() then
    raise exception 'Admin console is locked' using errcode = '42501';
  end if;
  if p_ids is null or cardinality(p_ids) = 0 or cardinality(p_ids) > 200 then
    raise exception 'Choose between 1 and 200 spaces' using errcode = '22023';
  end if;
  foreach v_id in array p_ids loop
    update public.organizations set deleted_at = now(), deleted_by = v_actor
    where id = v_id and deleted_at is null;
    if found then
      v_count := v_count + 1;
      -- A deleted space can no longer be joined with its codes.
      delete from public.organization_invite_codes where organization_id = v_id;
      update public.organization_invitations set revoked_at = now()
      where organization_id = v_id and accepted_at is null and revoked_at is null;
      insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, details)
      values (v_id, v_actor, 'platform_admin.space_deleted', 'organization', v_id::text,
        jsonb_build_object('reason', left(coalesce(p_reason, ''), 300)));
    end if;
  end loop;
  return v_count;
end;
$$;

create or replace function public.admin_restore_organizations(p_ids uuid[])
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_id uuid;
  v_count integer := 0;
begin
  if not public.is_platform_admin() then
    raise exception 'Admin console is locked' using errcode = '42501';
  end if;
  if p_ids is null or cardinality(p_ids) = 0 or cardinality(p_ids) > 200 then
    raise exception 'Choose between 1 and 200 spaces' using errcode = '22023';
  end if;
  foreach v_id in array p_ids loop
    update public.organizations set deleted_at = null, deleted_by = null where id = v_id and deleted_at is not null;
    if found then
      v_count := v_count + 1;
      -- Codes are made fresh on restore; the space owner can change them again.
      insert into public.organization_invite_codes (organization_id, code, secret)
      values (v_id, public.new_invite_code(), public.new_secret_code())
      on conflict (organization_id) do nothing;
      insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, details)
      values (v_id, v_actor, 'platform_admin.space_restored', 'organization', v_id::text, '{}'::jsonb);
    end if;
  end loop;
  return v_count;
end;
$$;

revoke all on function
  public.admin_list_organizations(boolean), public.admin_update_organization(uuid, text, text, text, text, text),
  public.admin_delete_organizations(uuid[], text), public.admin_restore_organizations(uuid[])
from public, anon;
grant execute on function
  public.admin_list_organizations(boolean), public.admin_update_organization(uuid, text, text, text, text, text),
  public.admin_delete_organizations(uuid[], text), public.admin_restore_organizations(uuid[])
to authenticated;
