-- Security hardening. FairShare handles money, so database access is closed down to what the app really needs.
--
-- 1) Functions. Supabase grants EXECUTE on new functions to anon and authenticated by default, and
--    "revoke ... from public" does not remove those grants. Anonymous callers get nothing (except the health check),
--    and internal helpers and service-only functions are not callable by signed-in users at all - otherwise a
--    platform admin could grant themselves console access without the password, or read anyone's balance.
-- 2) Tables. Row-level security decides which rows a signed-in user can touch, but it cannot stop a member from
--    inserting an expense whose splits do not add up, or a "confirmed" payment that never happened. All money records
--    and memberships are therefore written only by the audited, transactional functions (security definer), never
--    directly. Only profile names and a safe subset of space settings stay directly editable.

-- ---- 1) functions ----
alter default privileges for role postgres in schema public revoke execute on functions from public, anon, authenticated;

do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as signature
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e') -- skip extension functions
  loop
    execute format('revoke execute on function %s from public, anon', r.signature);
  end loop;
end $$;

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    -- internal helpers and triggers: only other database functions use them
    'public.member_net_balance(uuid,uuid)',
    'public.apply_group_split(uuid)',
    'public.resplit_group_expenses(uuid)',
    'public.new_invite_code()',
    'public.new_secret_code()',
    'public.is_admin_of_other_space(uuid,uuid)',
    'public.create_invite_code_for_new_organization()',
    'public.set_organization_owner()',
    'public.enforce_single_admin_space_on_create()',
    'public.add_organization_creator_as_admin()',
    'public.lock_expense_organization()',
    'public.handle_new_auth_user()',
    'public.set_updated_at()',
    -- server only (service role): console throttling and elevation
    'public.admin_unlock_status(uuid)',
    'public.admin_unlock_record(uuid,boolean)',
    'public.grant_admin_elevation(uuid,integer)',
    'public.revoke_admin_elevation(uuid)'
  ] loop
    if to_regprocedure(v_signature) is not null then
      execute format('revoke execute on function %s from authenticated', v_signature);
    end if;
  end loop;
end $$;

-- The scheduled health check calls this with the publishable key.
grant execute on function public.daily_health_check() to anon, authenticated;

-- ---- 2) tables ----
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
alter default privileges for role postgres in schema public revoke all on tables from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;
revoke truncate on all tables in schema public from authenticated;

-- Money records and memberships: written only through audited functions.
revoke insert, update, delete on public.expenses from authenticated;
revoke insert, update, delete on public.expense_splits from authenticated;
revoke insert, update, delete on public.settlements from authenticated;
revoke insert, update, delete on public.organization_members from authenticated;
revoke insert, update, delete on public.audit_logs from authenticated;
revoke insert, update, delete on public.platform_admins from authenticated;
revoke insert, update, delete on public.statement_settings from authenticated;

-- Internal tables: no client access at all.
revoke all on public.organization_invitations from authenticated;
revoke all on public.admin_elevations from authenticated;
revoke all on public.admin_unlock_attempts from authenticated;
revoke all on public.receipt_scans from authenticated;
revoke all on public.invite_code_attempts from authenticated;
revoke all on public.organization_invite_codes from authenticated;

-- Spaces: creating one is allowed; only harmless columns can be edited (not owner, currency, slug, status, deletion).
revoke update, delete on public.organizations from authenticated;
grant update (name, description, type, timezone, starts_on, ends_on) on public.organizations to authenticated;

-- Profiles: people edit their own name and avatar only.
revoke insert, update, delete on public.profiles from authenticated;
grant update (display_name, avatar_url) on public.profiles to authenticated;
