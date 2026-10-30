-- Read-only endpoint for an optional daily Cloudflare Cron Trigger. It returns
-- no project or tenant data and has no side effects.
create or replace function public.daily_health_check()
returns boolean
language sql
stable
set search_path = ''
as $$
  select true;
$$;

revoke all on function public.daily_health_check() from public;
grant execute on function public.daily_health_check() to anon, authenticated;
