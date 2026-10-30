-- Keep financial records immutable from direct client updates and route settlements
-- through audited, transactional functions.
revoke update on public.expenses, public.expense_splits, public.settlements from authenticated;

create or replace function public.lock_expense_organization()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform 1 from public.organizations where id = new.organization_id for update;
  return new;
end;
$$;
create trigger expenses_lock_organization_before_insert
before insert on public.expenses
for each row execute function public.lock_expense_organization();

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
    if v_actor <> v_settlement.from_member_id
      and not public.has_org_role(v_settlement.organization_id, array['admin']::public.organization_role[]) then
      raise exception 'Only the sender or an organization admin can cancel this transfer' using errcode = '42501';
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

revoke all on function public.record_settlement(uuid, uuid, uuid, bigint, text) from public;
revoke all on function public.resolve_settlement(uuid, text) from public;
grant execute on function public.record_settlement(uuid, uuid, uuid, bigint, text) to authenticated;
grant execute on function public.resolve_settlement(uuid, text) to authenticated;
