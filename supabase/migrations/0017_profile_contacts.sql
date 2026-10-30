-- Mobile numbers for identifying people whose email gives no clue about who they are.
-- Kept in its own table, not on profiles: profile rows are readable by everyone who shares a space, but a phone number
-- should be visible only to the person themselves and to admins of the spaces they belong to.
create table public.profile_contacts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  phone text check (phone is null or phone ~ '^\+[1-9][0-9]{7,14}$'),
  updated_at timestamptz not null default now()
);
alter table public.profile_contacts enable row level security;

create policy "contacts_read_self" on public.profile_contacts for select to authenticated
using (user_id = (select auth.uid()));
create policy "contacts_insert_self" on public.profile_contacts for insert to authenticated
with check (user_id = (select auth.uid()));
create policy "contacts_update_self" on public.profile_contacts for update to authenticated
using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create trigger profile_contacts_set_updated_at before update on public.profile_contacts
for each row execute function public.set_updated_at();

-- Email and phone of the active members of a space, for that space's admins only (elevated platform admins included).
create or replace function public.organization_member_contacts(p_organization_id uuid)
returns table (member_id uuid, email text, phone text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.has_org_role(p_organization_id, array['admin']::public.organization_role[]) then
    raise exception 'Only organization admins can see member contact details' using errcode = '42501';
  end if;
  return query
    select m.user_id, lower(u.email::text), c.phone
    from public.organization_members m
    join auth.users u on u.id = m.user_id
    left join public.profile_contacts c on c.user_id = m.user_id
    where m.organization_id = p_organization_id and m.status = 'active';
end;
$$;
revoke all on function public.organization_member_contacts(uuid) from public;
grant execute on function public.organization_member_contacts(uuid) to authenticated;
