-- Receipt scanning calls a paid AI service, so every scan is recorded and limited per person.
create table public.receipt_scans (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index receipt_scans_user_created_idx on public.receipt_scans(user_id, created_at desc);
alter table public.receipt_scans enable row level security;
-- No policies: rows are written only by claim_receipt_scan.

-- Call before every scan. Only members who may add expenses can scan, at most p_limit scans per hour per person.
create or replace function public.claim_receipt_scan(p_organization_id uuid, p_limit integer default 20)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if not public.has_org_role(p_organization_id, array['admin', 'member']::public.organization_role[]) then
    raise exception 'Only members who can add expenses can scan receipts' using errcode = '42501';
  end if;
  if (select count(*) from public.receipt_scans s where s.user_id = v_actor and s.created_at > now() - interval '1 hour') >= greatest(p_limit, 1) then
    raise exception 'You have reached the receipt scan limit for this hour. Please try again later.' using errcode = '54000';
  end if;
  insert into public.receipt_scans (organization_id, user_id) values (p_organization_id, v_actor);
end;
$$;
revoke all on function public.claim_receipt_scan(uuid, integer) from public;
grant execute on function public.claim_receipt_scan(uuid, integer) to authenticated;
