-- Trusted transactional write: one expense + all splits + audit event in a single transaction.
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
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required' using errcode = '42501';
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
revoke all on function public.create_expense_with_splits(uuid,text,text,bigint,char,date,uuid,public.expense_category,public.split_method,jsonb) from public;
grant execute on function public.create_expense_with_splits(uuid,text,text,bigint,char,date,uuid,public.expense_category,public.split_method,jsonb) to authenticated;
