create table if not exists public.monthly_locks (
  bill_month date primary key,
  locked_at timestamptz not null default now(),
  locked_by uuid references auth.users(id) on delete set null,
  note text
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_email text,
  action text not null,
  target_table text,
  target_id text,
  bill_month date,
  room_id uuid references public.rooms(id) on delete set null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.audit_logs
alter column target_id type text using target_id::text;

create index if not exists idx_audit_logs_created_at on public.audit_logs(created_at desc);
create index if not exists idx_audit_logs_bill_month on public.audit_logs(bill_month);
create index if not exists idx_audit_logs_room on public.audit_logs(room_id);

alter table public.monthly_locks enable row level security;
alter table public.audit_logs enable row level security;

create or replace function public.enforce_monthly_bill_lock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_month date;
begin
  if TG_OP = 'DELETE' then
    target_month := old.bill_month;
  else
    target_month := new.bill_month;
  end if;

  if exists (
    select 1
    from public.monthly_locks
    where bill_month = target_month
  ) then
    raise exception 'This bill month is locked';
  end if;

  if TG_OP = 'DELETE' then
    return old;
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_monthly_bill_lock on public.monthly_bills;
create trigger enforce_monthly_bill_lock
before insert or update or delete on public.monthly_bills
for each row execute function public.enforce_monthly_bill_lock();

drop policy if exists monthly_locks_select on public.monthly_locks;
create policy monthly_locks_select on public.monthly_locks
for select using (public.is_role(array['super_admin','accountant_a','cash_collector_b','viewer']::public.app_role[]));

drop policy if exists monthly_locks_super_admin_manage on public.monthly_locks;
create policy monthly_locks_super_admin_manage on public.monthly_locks
for all using (public.is_role(array['super_admin']::public.app_role[]))
with check (public.is_role(array['super_admin']::public.app_role[]));

drop policy if exists audit_logs_super_admin_select on public.audit_logs;
create policy audit_logs_super_admin_select on public.audit_logs
for select using (public.is_role(array['super_admin']::public.app_role[]));

drop policy if exists audit_logs_authenticated_insert on public.audit_logs;
create policy audit_logs_authenticated_insert on public.audit_logs
for insert with check (auth.uid() = actor_user_id);
