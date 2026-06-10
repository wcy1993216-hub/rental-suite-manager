do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'rooms') then
      execute 'alter publication supabase_realtime add table public.rooms';
    end if;

    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tenants') then
      execute 'alter publication supabase_realtime add table public.tenants';
    end if;

    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'contracts') then
      execute 'alter publication supabase_realtime add table public.contracts';
    end if;

    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'monthly_bills') then
      execute 'alter publication supabase_realtime add table public.monthly_bills';
    end if;
  end if;
end $$;
