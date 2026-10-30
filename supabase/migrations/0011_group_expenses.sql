-- Group-level expenses: split equally across everyone currently in the group, including people who join later.
-- The split is always calculated in the database and stored in expense_splits, so balances, settlements and
-- removal checks keep working from a single source of truth.
--
-- Rules:
--   * Active members share the expense equally (remainder minor units go to the earliest member ids).
--   * Former members keep the share they already had (frozen), so a settled member's balance never changes.
--   * Joining the group re-divides every group expense; leaving the group does not.

alter table public.expenses
  add column split_scope text not null default 'selected' check (split_scope in ('selected', 'group'));

-- Internal: recompute the active members' shares of one group expense.
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
  where m.organization_id = v_expense.organization_id and m.status = 'active';

  select coalesce(sum(s.amount_minor), 0) into v_frozen
  from public.expense_splits s
  where s.expense_id = p_expense_id
    and not exists (
      select 1 from public.organization_members m
      where m.organization_id = s.organization_id and m.user_id = s.member_id and m.status = 'active'
    );

  v_remaining := v_expense.amount_minor - v_frozen;
  if v_count = 0 or v_remaining < 0 then
    raise exception 'This expense cannot be split across the current group' using errcode = '22023';
  end if;

  delete from public.expense_splits s
  where s.expense_id = p_expense_id
    and exists (
      select 1 from public.organization_members m
      where m.organization_id = s.organization_id and m.user_id = s.member_id and m.status = 'active'
    );

  insert into public.expense_splits (expense_id, organization_id, member_id, amount_minor)
  select p_expense_id, v_expense.organization_id, r.user_id,
    (v_remaining / v_count) + case when r.rn <= (v_remaining % v_count) then 1 else 0 end
  from (
    select m.user_id, row_number() over (order by m.user_id::text) as rn
    from public.organization_members m
    where m.organization_id = v_expense.organization_id and m.status = 'active'
  ) r;

  update public.expenses set updated_at = now() where id = p_expense_id;
end;
$$;

-- Internal: re-divide every live group expense of an organization (called when someone joins).
create or replace function public.resplit_group_expenses(p_organization_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_expense_id uuid;
  v_done integer := 0;
begin
  for v_expense_id in
    select e.id from public.expenses e
    where e.organization_id = p_organization_id and e.split_scope = 'group'
      and e.status = 'active' and e.deleted_at is null
    order by e.created_at
  loop
    begin
      perform public.apply_group_split(v_expense_id);
      v_done := v_done + 1;
    exception when others then
      -- One expense that cannot be re-divided must never block someone from joining.
      null;
    end;
  end loop;
  return v_done;
end;
$$;

-- Create a group expense. The client sends no splits; the database divides it among the active members.
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
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  perform 1 from public.organizations where id = p_organization_id and deleted_at is null for update;
  if not found then
    raise exception 'Organization not found' using errcode = '22023';
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

-- Edit an expense as a group expense (also converts a "selected people" expense into a group expense).
create or replace function public.update_group_expense(
  p_expense_id uuid,
  p_expected_updated_at timestamptz,
  p_title text,
  p_description text,
  p_amount_minor bigint,
  p_expense_date date,
  p_payer_id uuid,
  p_category public.expense_category
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_expense public.expenses%rowtype;
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

  update public.expenses
  set title = trim(p_title),
      description = nullif(trim(coalesce(p_description, '')), ''),
      amount_minor = p_amount_minor,
      expense_date = p_expense_date,
      payer_id = p_payer_id,
      category = p_category,
      split_method = 'equal',
      split_scope = 'group',
      updated_by = v_actor
  where id = p_expense_id;

  perform public.apply_group_split(p_expense_id);

  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, details)
  values (v_expense.organization_id, v_actor, 'expense.updated', 'expense', p_expense_id::text,
    jsonb_build_object('before_amount_minor', v_expense.amount_minor, 'after_amount_minor', p_amount_minor,
      'before_title', v_expense.title, 'after_title', trim(p_title), 'scope', 'group'));
end;
$$;

-- Editing with explicit participants turns an expense back into a "selected people" expense.
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
      split_scope = 'selected',
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

-- Joining the group re-divides every group expense so the new member shares them too.
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
  where o.id = v_invitation.organization_id and o.deleted_at is null and o.status = 'active'
  for update;
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

revoke all on function public.apply_group_split(uuid) from public;
revoke all on function public.resplit_group_expenses(uuid) from public;
revoke all on function public.create_group_expense(uuid, text, text, bigint, char, date, uuid, public.expense_category) from public;
revoke all on function public.update_group_expense(uuid, timestamptz, text, text, bigint, date, uuid, public.expense_category) from public;
grant execute on function public.create_group_expense(uuid, text, text, bigint, char, date, uuid, public.expense_category) to authenticated;
grant execute on function public.update_group_expense(uuid, timestamptz, text, text, bigint, date, uuid, public.expense_category) to authenticated;
