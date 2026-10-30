-- Member administration (roles, removal, leaving) and expense management (edit, bulk delete by date range).
-- All writes are transactional, audited, and serialised on the organization row so concurrent admins cannot
-- leave an organization without an admin or overwrite each other's edits silently.

-- Net position of one member: paid - share, adjusted by pending/confirmed transfers. Internal helper only.
create or replace function public.member_net_balance(p_organization_id uuid, p_member_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce((select sum(e.amount_minor) from public.expenses e where e.organization_id = p_organization_id and e.payer_id = p_member_id and e.status = 'active' and e.deleted_at is null), 0)
    - coalesce((select sum(s.amount_minor) from public.expense_splits s join public.expenses e on e.id = s.expense_id and e.organization_id = s.organization_id where s.organization_id = p_organization_id and s.member_id = p_member_id and e.status = 'active' and e.deleted_at is null), 0)
    + coalesce((select sum(st.amount_minor) from public.settlements st where st.organization_id = p_organization_id and st.from_member_id = p_member_id and st.status in ('pending', 'confirmed')), 0)
    - coalesce((select sum(st.amount_minor) from public.settlements st where st.organization_id = p_organization_id and st.to_member_id = p_member_id and st.status in ('pending', 'confirmed')), 0);
$$;
revoke all on function public.member_net_balance(uuid, uuid) from public;

-- ---------------------------------------------------------------------------------------------------------
-- Change a member's role. Admins can promote/demote anyone, but the last admin cannot be demoted.
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
  if v_current = 'admin' and not exists (
    select 1 from public.organization_members
    where organization_id = p_organization_id and status = 'active' and role = 'admin' and user_id <> p_user_id
  ) then
    raise exception 'This is the only admin. Make someone else an admin first.' using errcode = '22023';
  end if;

  update public.organization_members
  set role = p_role
  where organization_id = p_organization_id and user_id = p_user_id;

  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, details)
  values (p_organization_id, v_actor, 'member.role_changed', 'member', p_user_id::text,
    jsonb_build_object('from', v_current, 'to', p_role));
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- Remove a member (admin) or leave (self). The member must be settled up so that balances stay reconcilable.
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
    raise exception 'This is the only admin. Make someone else an admin first.' using errcode = '22023';
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

-- ---------------------------------------------------------------------------------------------------------
-- Edit an expense and replace its splits atomically. Author (member) or admin. Optimistic concurrency via
-- p_expected_updated_at so two people editing the same expense cannot overwrite each other unnoticed.
create or replace function public.update_expense_with_splits(
  p_expense_id uuid,
  p_expected_updated_at timestamptz,
  p_title text,
  p_description text,
  p_amount_minor bigint,
  p_expense_date date,
  p_payer_id uuid,
  p_category public.expense_category,
  p_split_method public.split_method,
  p_splits jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_expense public.expenses%rowtype;
  v_split_sum numeric;
  v_split_count integer;
  v_member_count integer;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select * into v_expense from public.expenses where id = p_expense_id for update;
  if not found or v_expense.deleted_at is not null or v_expense.status <> 'active' then
    raise exception 'Expense not found' using errcode = '22023';
  end if;
  perform 1 from public.organizations where id = v_expense.organization_id for update;

  if not (
    public.has_org_role(v_expense.organization_id, array['admin']::public.organization_role[])
    or (v_expense.created_by = v_actor and public.has_org_role(v_expense.organization_id, array['member']::public.organization_role[]))
  ) then
    raise exception 'Only the author or an organization admin can edit this expense' using errcode = '42501';
  end if;
  if p_expected_updated_at is not null and v_expense.updated_at <> p_expected_updated_at then
    raise exception 'This expense was changed by someone else. Reload and try again.' using errcode = '40001';
  end if;

  if p_title is null or char_length(trim(p_title)) not between 1 and 140 then
    raise exception 'Invalid expense title' using errcode = '22023';
  end if;
  if p_amount_minor is null or p_amount_minor <= 0 then
    raise exception 'Amount must be positive' using errcode = '22023';
  end if;
  if p_payer_id is null or not exists (
    select 1 from public.organization_members m where m.organization_id = v_expense.organization_id
      and m.user_id = p_payer_id and m.status = 'active'
  ) then
    raise exception 'The payer must be an active member' using errcode = '22023';
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
    left join public.organization_members m on m.organization_id = v_expense.organization_id
      and m.user_id = (s.value ->> 'member_id')::uuid and m.status = 'active'
    where m.user_id is null or (s.value ->> 'amount_minor') is null
      or (s.value ->> 'amount_minor')::bigint < 0
  ) then
    raise exception 'Every participant must be an active member. Former members cannot be part of an edited expense.' using errcode = '22023';
  end if;

  update public.expenses
  set title = trim(p_title),
      description = nullif(trim(coalesce(p_description, '')), ''),
      amount_minor = p_amount_minor,
      expense_date = p_expense_date,
      payer_id = p_payer_id,
      category = p_category,
      split_method = p_split_method,
      updated_by = v_actor
  where id = p_expense_id;

  delete from public.expense_splits where expense_id = p_expense_id;
  insert into public.expense_splits (expense_id, organization_id, member_id, amount_minor)
  select p_expense_id, v_expense.organization_id, (s.value ->> 'member_id')::uuid, (s.value ->> 'amount_minor')::bigint
  from jsonb_array_elements(p_splits) as s(value);

  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, details)
  values (v_expense.organization_id, v_actor, 'expense.updated', 'expense', p_expense_id::text,
    jsonb_build_object('before_amount_minor', v_expense.amount_minor, 'after_amount_minor', p_amount_minor,
      'before_title', v_expense.title, 'after_title', trim(p_title), 'split_count', v_split_count));
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- Admin reset: void every active expense dated between p_from and p_to (inclusive). Optionally also cancels
-- transfers recorded in the same period so the books do not keep phantom balances. Returns the expense count.
create or replace function public.void_expenses_in_range(
  p_organization_id uuid,
  p_from date,
  p_to date,
  p_include_settlements boolean default false
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_count integer;
  v_total numeric;
  v_settlements integer := 0;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'Choose a valid date range' using errcode = '22023';
  end if;
  perform 1 from public.organizations where id = p_organization_id and deleted_at is null for update;
  if not found then
    raise exception 'Organization not found' using errcode = '22023';
  end if;
  if not public.has_org_role(p_organization_id, array['admin']::public.organization_role[]) then
    raise exception 'Only organization admins can delete expenses in bulk' using errcode = '42501';
  end if;

  select count(*), coalesce(sum(amount_minor), 0) into v_count, v_total
  from public.expenses
  where organization_id = p_organization_id and status = 'active' and deleted_at is null
    and expense_date between p_from and p_to;

  update public.expenses
  set status = 'voided', deleted_at = now(), deleted_by = v_actor, updated_by = v_actor,
      deletion_reason = 'Bulk delete ' || p_from::text || ' to ' || p_to::text
  where organization_id = p_organization_id and status = 'active' and deleted_at is null
    and expense_date between p_from and p_to;

  if coalesce(p_include_settlements, false) then
    update public.settlements
    set status = 'cancelled'
    where organization_id = p_organization_id and status in ('pending', 'confirmed')
      and created_at::date between p_from and p_to;
    get diagnostics v_settlements = row_count;
  end if;

  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, details)
  values (p_organization_id, v_actor, 'expense.bulk_void', 'organization', p_organization_id::text,
    jsonb_build_object('from', p_from, 'to', p_to, 'expense_count', v_count, 'total_minor', v_total,
      'settlements_cancelled', v_settlements));

  return v_count;
end;
$$;

revoke all on function public.set_member_role(uuid, uuid, public.organization_role) from public;
revoke all on function public.remove_organization_member(uuid, uuid) from public;
revoke all on function public.update_expense_with_splits(uuid, timestamptz, text, text, bigint, date, uuid, public.expense_category, public.split_method, jsonb) from public;
revoke all on function public.void_expenses_in_range(uuid, date, date, boolean) from public;
grant execute on function public.set_member_role(uuid, uuid, public.organization_role) to authenticated;
grant execute on function public.remove_organization_member(uuid, uuid) to authenticated;
grant execute on function public.update_expense_with_splits(uuid, timestamptz, text, text, bigint, date, uuid, public.expense_category, public.split_method, jsonb) to authenticated;
grant execute on function public.void_expenses_in_range(uuid, date, date, boolean) to authenticated;
