-- Phase 2 data foundation: expenses, participant allocations, settlements and audit events.
create type public.expense_category as enum ('food', 'rent', 'groceries', 'transport', 'accommodation', 'utilities', 'shopping', 'entertainment', 'medical', 'travel', 'miscellaneous');
create type public.split_method as enum ('equal', 'custom', 'percentage', 'weighted', 'per_day');
create type public.financial_record_status as enum ('active', 'voided', 'archived');
create type public.settlement_status as enum ('pending', 'confirmed', 'cancelled');

create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  title text not null check (char_length(trim(title)) between 1 and 140),
  description text check (description is null or char_length(description) <= 3000),
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  expense_date date not null,
  payer_id uuid not null references auth.users(id) on delete restrict,
  category public.expense_category not null default 'miscellaneous',
  split_method public.split_method not null default 'equal',
  status public.financial_record_status not null default 'active',
  created_by uuid not null references auth.users(id) on delete restrict,
  updated_by uuid references auth.users(id) on delete set null,
  deleted_at timestamptz,
  deleted_by uuid references auth.users(id) on delete set null,
  deletion_reason text check (deletion_reason is null or char_length(deletion_reason) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id)
);
create index expenses_org_date_idx on public.expenses(organization_id, expense_date desc) where status = 'active' and deleted_at is null;
create index expenses_payer_idx on public.expenses(organization_id, payer_id) where status = 'active' and deleted_at is null;
create trigger expenses_set_updated_at before update on public.expenses for each row execute function public.set_updated_at();

create table public.expense_splits (
  id uuid primary key default gen_random_uuid(),
  expense_id uuid not null,
  organization_id uuid not null,
  member_id uuid not null references auth.users(id) on delete restrict,
  amount_minor bigint not null check (amount_minor >= 0),
  weight numeric(12,4) check (weight is null or weight > 0),
  created_at timestamptz not null default now(),
  foreign key (expense_id, organization_id) references public.expenses(id, organization_id) on delete restrict,
  foreign key (organization_id, member_id) references public.organization_members(organization_id, user_id) on delete restrict,
  unique (expense_id, member_id)
);
create index expense_splits_org_member_idx on public.expense_splits(organization_id, member_id);

create table public.settlements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  from_member_id uuid not null,
  to_member_id uuid not null,
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  status public.settlement_status not null default 'pending',
  note text check (note is null or char_length(note) <= 1000),
  created_by uuid not null references auth.users(id) on delete restrict,
  confirmed_by uuid references auth.users(id) on delete set null,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (from_member_id <> to_member_id),
  foreign key (organization_id, from_member_id) references public.organization_members(organization_id, user_id) on delete restrict,
  foreign key (organization_id, to_member_id) references public.organization_members(organization_id, user_id) on delete restrict
);
create index settlements_org_status_idx on public.settlements(organization_id, status, created_at desc);
create trigger settlements_set_updated_at before update on public.settlements for each row execute function public.set_updated_at();

create table public.audit_logs (
  id bigint generated always as identity primary key,
  organization_id uuid references public.organizations(id) on delete restrict,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null check (char_length(action) between 1 and 100),
  entity_type text not null check (char_length(entity_type) between 1 and 80),
  entity_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_org_created_idx on public.audit_logs(organization_id, created_at desc);

alter table public.expenses enable row level security;
alter table public.expense_splits enable row level security;
alter table public.settlements enable row level security;
alter table public.audit_logs enable row level security;

create policy "members_read_expenses" on public.expenses for select to authenticated
using ((public.is_org_member(organization_id) and deleted_at is null) or public.is_platform_admin());
create policy "members_create_expenses" on public.expenses for insert to authenticated
with check (public.has_org_role(organization_id, array['admin','member']::public.organization_role[]) and created_by = (select auth.uid()) and payer_id in (select m.user_id from public.organization_members m where m.organization_id = expenses.organization_id and m.status = 'active'));
create policy "authors_or_admins_update_expenses" on public.expenses for update to authenticated
using (public.has_org_role(organization_id, array['admin']::public.organization_role[]) or (created_by = (select auth.uid()) and public.has_org_role(organization_id, array['member']::public.organization_role[])) or public.is_platform_admin())
with check (public.has_org_role(organization_id, array['admin','member']::public.organization_role[]) or public.is_platform_admin());

create policy "members_read_splits" on public.expense_splits for select to authenticated
using (public.is_org_member(organization_id) or public.is_platform_admin());
create policy "authorized_create_splits" on public.expense_splits for insert to authenticated
with check (public.has_org_role(organization_id, array['admin','member']::public.organization_role[]) or public.is_platform_admin());
create policy "authorized_update_splits" on public.expense_splits for update to authenticated
using (public.has_org_role(organization_id, array['admin','member']::public.organization_role[]) or public.is_platform_admin())
with check (public.has_org_role(organization_id, array['admin','member']::public.organization_role[]) or public.is_platform_admin());

create policy "members_read_settlements" on public.settlements for select to authenticated
using (public.is_org_member(organization_id) or public.is_platform_admin());
create policy "members_create_settlements" on public.settlements for insert to authenticated
with check (public.has_org_role(organization_id, array['admin','member']::public.organization_role[]) and created_by = (select auth.uid()));
create policy "parties_or_admin_update_settlement" on public.settlements for update to authenticated
using ((public.is_org_member(organization_id) and ((from_member_id = (select auth.uid())) or (to_member_id = (select auth.uid())) or public.has_org_role(organization_id, array['admin']::public.organization_role[]))) or public.is_platform_admin())
with check (public.is_org_member(organization_id) or public.is_platform_admin());

create policy "admins_read_audit_logs" on public.audit_logs for select to authenticated
using (public.has_org_role(organization_id, array['admin']::public.organization_role[]) or public.is_platform_admin());
-- No direct client insert/update/delete policies for audit logs. Writes should go through trusted server-side functions.
