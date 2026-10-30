-- Let the expense author or an organization admin remove an expense without direct client updates.
-- The row is soft-deleted (voided) so the audit trail and historical settlements stay intact.
create or replace function public.void_expense(p_expense_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_expense public.expenses%rowtype;
  v_actor uuid := (select auth.uid());
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select * into v_expense
  from public.expenses
  where id = p_expense_id
  for update;
  if not found or v_expense.deleted_at is not null or v_expense.status <> 'active' then
    raise exception 'Expense not found' using errcode = '22023';
  end if;
  perform 1 from public.organizations where id = v_expense.organization_id for update;

  if not (
    public.has_org_role(v_expense.organization_id, array['admin']::public.organization_role[])
    or (v_expense.created_by = v_actor and public.has_org_role(v_expense.organization_id, array['member']::public.organization_role[]))
  ) then
    raise exception 'Only the author or an organization admin can delete this expense' using errcode = '42501';
  end if;

  update public.expenses
  set status = 'voided',
      deleted_at = now(),
      deleted_by = v_actor,
      updated_by = v_actor,
      deletion_reason = nullif(left(trim(coalesce(p_reason, '')), 500), '')
  where id = p_expense_id;

  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, details)
  values (v_expense.organization_id, v_actor, 'expense.void', 'expense', p_expense_id::text,
    jsonb_build_object('amount_minor', v_expense.amount_minor, 'currency', v_expense.currency, 'title', v_expense.title));
end;
$$;

revoke all on function public.void_expense(uuid, text) from public;
grant execute on function public.void_expense(uuid, text) to authenticated;
