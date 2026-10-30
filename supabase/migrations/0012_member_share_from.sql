-- Per-member "shares expenses from" date for whole-group expenses.
--   share_from is null  -> the member shares every group expense (from the beginning).
--   share_from = a date -> the member shares only group expenses dated on or after it.
-- New joiners start from the day they join (in the organization's timezone); an admin can move that date.
-- Expenses with explicitly selected people are never affected.

alter table public.organization_members add column share_from date;

-- Recompute the active members' shares of one group expense. Eligible = active and share_from <= expense date.
-- Former members keep their frozen share so a settled member's balance never changes.
create or replace function public.apply_group_split(p_expense_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_expense public.expenses%rowtype;
  v_frozen bigint;
  v_remaining bigint;
  v_count integer;
begin
  select * into v_expense from public.expenses where id = p_expense_id;
  if not found then
    return;
  end if;

  select count(*) into v_count
  from public.organization_members m
  where m.organization_id = v_expense.organization_id and m.status = 'active'
    and (m.share_from is null or m.share_from <= v_expense.expense_date);

  select coalesce(sum(s.amount_minor), 0) into v_frozen
  from public.expense_splits s
  where s.expense_id = p_expense_id
    and not exists (
      select 1 from public.organization_members m
      where m.organization_id = s.organization_id and m.user_id = s.member_id and m.status = 'active'
    );

  v_remaining := v_expense.amount_minor - v_frozen;
  if v_remaining < 0 or (v_count = 0 and v_remaining > 0) then
    raise exception 'Nobody in the group shares expenses from that date. Pick a later date or change when members start sharing.' using errcode = '22023';
  end if;

  -- Drop every active member's share first (including members who are not eligible for this date).
  delete from public.expense_splits s
  where s.expense_id = p_expense_id
    and exists (
      select 1 from public.organization_members m
      where m.organization_id = s.organization_id and m.user_id = s.member_id and m.status = 'active'
    );

  if v_count > 0 then
    insert into public.expense_splits (expense_id, organization_id, member_id, amount_minor)
    select p_expense_id, v_expense.organization_id, r.user_id,
      (v_remaining / v_count) + case when r.rn <= (v_remaining % v_count) then 1 else 0 end
    from (
      select m.user_id, row_number() over (order by m.user_id::text) as rn
      from public.organization_members m
      where m.organization_id = v_expense.organization_id and m.status = 'active'
        and (m.share_from is null or m.share_from <= v_expense.expense_date)
    ) r;
  end if;

  update public.expenses set updated_at = now() where id = p_expense_id;
end;
$$;

-- Admin: choose from which date a member starts sharing group expenses (null = from the beginning).
create or replace function public.set_member_share_from(p_organization_id uuid, p_user_id uuid, p_share_from date)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_previous date;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  perform 1 from public.organizations where id = p_organization_id and deleted_at is null for update;
  if not found then
    raise exception 'Organization not found' using errcode = '22023';
  end if;
  if not public.has_org_role(p_organization_id, array['admin']::public.organization_role[]) then
    raise exception 'Only organization admins can change when a member starts sharing' using errcode = '42501';
  end if;

  select share_from into v_previous
  from public.organization_members
  where organization_id = p_organization_id and user_id = p_user_id and status = 'active'
  for update;
  if not found then
    raise exception 'That person is not an active member' using errcode = '22023';
  end if;

  update public.organization_members
  set share_from = p_share_from
  where organization_id = p_organization_id and user_id = p_user_id;

  -- Re-divide group expenses; an expense that can no longer be divided is left as it was.
  perform public.resplit_group_expenses(p_organization_id);

  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, details)
  values (p_organization_id, v_actor, 'member.share_from_changed', 'member', p_user_id::text,
    jsonb_build_object('from', v_previous, 'to', p_share_from));
end;
$$;

-- New joiners share group expenses from the day they join. Returning members keep their previous setting.
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

revoke all on function public.set_member_share_from(uuid, uuid, date) from public;
grant execute on function public.set_member_share_from(uuid, uuid, date) to authenticated;
