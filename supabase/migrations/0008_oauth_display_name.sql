-- Google (and other OAuth) sign-ins provide full_name/name instead of display_name.
-- Prefer an explicit display_name, then the provider name, then the email prefix.
create or replace function public.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    left(coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
      nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
      nullif(trim(new.raw_user_meta_data ->> 'name'), ''),
      split_part(coalesce(new.email, 'member'), '@', 1)
    ), 100)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;
