-- Statement settings: only real admins (not a super admin) can change them, and only the owner can change the
-- extra recipient addresses, so a helper admin cannot send a space's balances to an outside address.

create or replace function public.save_statement_settings(
  p_organization_id uuid,
  p_enabled boolean,
  p_day_of_month integer,
  p_recipients_mode text,
  p_extra_emails text[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_emails text[];
  v_email text;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  perform 1 from public.organizations where id = p_organization_id and deleted_at is null;
  if not found then
    raise exception 'Organization not found' using errcode = '22023';
  end if;
  if not public.is_org_admin_member(p_organization_id) then
    raise exception 'Only organization admins can change statement settings' using errcode = '42501';
  end if;
  if p_day_of_month is null or p_day_of_month not between 1 and 28 then
    raise exception 'Choose a day between 1 and 28' using errcode = '22023';
  end if;
  if p_recipients_mode is null or p_recipients_mode not in ('all_members', 'admins', 'extra_only') then
    raise exception 'Choose who receives the statement' using errcode = '22023';
  end if;

  select coalesce(array_agg(distinct lower(trim(e))), '{}') into v_emails
  from unnest(coalesce(p_extra_emails, '{}')) as e
  where trim(e) <> '';
  if cardinality(v_emails) > 20 then
    raise exception 'You can add up to 20 extra email addresses' using errcode = '22023';
  end if;
  foreach v_email in array v_emails loop
    if v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or char_length(v_email) > 254 then
      raise exception 'Invalid email address: %', v_email using errcode = '22023';
    end if;
  end loop;
  if p_recipients_mode = 'extra_only' and cardinality(v_emails) = 0 and p_enabled then
    raise exception 'Add at least one email address, or choose another recipient option' using errcode = '22023';
  end if;

  -- Statements carry balances, so sending them to outside addresses is the owner's decision alone.
  if v_emails is distinct from coalesce((select s.extra_emails from public.statement_settings s where s.organization_id = p_organization_id), '{}'::text[])
    and not exists (select 1 from public.organizations o where o.id = p_organization_id and o.owner_id = v_actor) then
    raise exception 'Only the owner can change the extra email addresses' using errcode = '42501';
  end if;

  insert into public.statement_settings (organization_id, enabled, day_of_month, recipients_mode, extra_emails, updated_by)
  values (p_organization_id, p_enabled, p_day_of_month, p_recipients_mode, v_emails, v_actor)
  on conflict (organization_id) do update
    set enabled = excluded.enabled,
        day_of_month = excluded.day_of_month,
        recipients_mode = excluded.recipients_mode,
        extra_emails = excluded.extra_emails,
        updated_by = excluded.updated_by,
        updated_at = now();

  insert into public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, details)
  values (p_organization_id, v_actor, 'statement.settings_updated', 'organization', p_organization_id::text,
    jsonb_build_object('enabled', p_enabled, 'day_of_month', p_day_of_month, 'recipients_mode', p_recipients_mode,
      'extra_email_count', cardinality(v_emails)));
end;
$$;
