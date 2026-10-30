-- Live updates: stream changes of the shared tables to signed-in members through Supabase Realtime.
-- Realtime applies row-level security, so a member only receives changes for spaces they can read.
-- REPLICA IDENTITY FULL lets update/delete events carry organization_id, which the per-space filter needs.
alter table public.expenses replica identity full;
alter table public.expense_splits replica identity full;
alter table public.settlements replica identity full;
alter table public.organization_members replica identity full;

do $$
declare
  v_table text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    return;
  end if;
  foreach v_table in array array['expenses', 'expense_splits', 'settlements', 'organization_members'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', v_table);
    exception when duplicate_object then
      null; -- already published
    end;
  end loop;
end $$;
