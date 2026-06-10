create extension if not exists pgcrypto;

do $$ begin
  create type public.app_role as enum ('super_admin', 'accountant_a', 'cash_collector_b', 'viewer');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.room_status as enum ('vacant', 'occupied', 'moving_out', 'disabled');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.contract_status as enum ('active', 'ended');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.rent_payment_cycle as enum ('monthly', 'semiannual', 'annual');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.payment_method as enum ('bank_transfer', 'cash', 'none');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.payment_status as enum ('unpaid', 'bank_paid', 'cash_paid', 'partial_paid', 'pending', 'abnormal', 'vacant', 'rent_prepaid');
exception when duplicate_object then null;
end $$;

alter type public.payment_status add value if not exists 'partial_paid';
alter type public.payment_status add value if not exists 'vacant';
alter type public.payment_status add value if not exists 'rent_prepaid';

do $$ begin
  create type public.maintenance_status as enum ('pending', 'processing', 'completed');
exception when duplicate_object then null;
end $$;

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  building text,
  floor text,
  room_number text not null unique,
  status public.room_status not null default 'vacant',
  note text,
  created_at timestamptz not null default now()
);

create table if not exists public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  id_last4 text,
  note text,
  created_at timestamptz not null default now()
);

create table if not exists public.contracts (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete restrict,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  start_date date,
  end_date date,
  monthly_rent numeric(12, 2) not null default 0,
  payment_due_day integer,
  rent_payment_cycle public.rent_payment_cycle not null default 'monthly',
  rent_paid_until date,
  cleaning_fee numeric(12, 2) not null default 0,
  parking_fee numeric(12, 2) not null default 0,
  deposit numeric(12, 2) not null default 0,
  status public.contract_status not null default 'active',
  move_in_date date,
  move_out_date date,
  note text,
  created_at timestamptz not null default now()
);

alter table public.contracts
  add column if not exists payment_due_day integer;

alter table public.contracts
  drop constraint if exists contracts_payment_due_day_check;

alter table public.contracts
  add constraint contracts_payment_due_day_check
  check (payment_due_day is null or (payment_due_day >= 1 and payment_due_day <= 31));

alter table public.contracts
  add column if not exists rent_payment_cycle public.rent_payment_cycle not null default 'monthly';

alter table public.contracts
  add column if not exists rent_paid_until date;

alter table public.contracts
  add column if not exists cleaning_fee numeric(12, 2) not null default 0;

alter table public.contracts
  add column if not exists parking_fee numeric(12, 2) not null default 0;

create table if not exists public.monthly_bills (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete restrict,
  contract_id uuid references public.contracts(id) on delete set null,
  bill_month date not null,
  rent_amount numeric(12, 2) not null default 0,
  recurring_fee numeric(12, 2) not null default 0,
  electricity_fee numeric(12, 2) not null default 0,
  water_common_electricity_fee numeric(12, 2) not null default 0,
  misc_fee numeric(12, 2) not null default 0,
  total_amount numeric(12, 2) not null default 0,
  payment_method public.payment_method not null default 'none',
  payment_status public.payment_status not null default 'unpaid',
  paid_date date,
  transfer_last5 text,
  transfer_amount numeric(12, 2),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (room_id, bill_month)
);

alter table public.monthly_bills
  add column if not exists recurring_fee numeric(12, 2) not null default 0;

alter table public.monthly_bills
  add column if not exists water_common_electricity_fee numeric(12, 2) not null default 0;

create table if not exists public.maintenance_records (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete restrict,
  contract_id uuid references public.contracts(id) on delete set null,
  repair_date date not null default current_date,
  title text not null,
  description text,
  status public.maintenance_status not null default 'pending',
  cost numeric(12, 2) not null default 0,
  worker text,
  note text,
  created_at timestamptz not null default now()
);

create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  display_name text,
  role public.app_role not null default 'viewer',
  created_at timestamptz not null default now()
);

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

create index if not exists idx_monthly_bills_bill_month on public.monthly_bills(bill_month);
create index if not exists idx_monthly_bills_payment_status on public.monthly_bills(payment_status);
create index if not exists idx_monthly_bills_payment_method on public.monthly_bills(payment_method);
create unique index if not exists idx_monthly_bills_one_per_room_month on public.monthly_bills(room_id, bill_month);
create index if not exists idx_contracts_room_status on public.contracts(room_id, status);
create unique index if not exists idx_contracts_one_active_per_room on public.contracts(room_id) where status = 'active';
create index if not exists idx_maintenance_records_room on public.maintenance_records(room_id);
create index if not exists idx_audit_logs_created_at on public.audit_logs(created_at desc);
create index if not exists idx_audit_logs_bill_month on public.audit_logs(bill_month);
create index if not exists idx_audit_logs_room on public.audit_logs(room_id);

create or replace function public.current_app_role()
returns public.app_role
language sql
security definer
set search_path = public
stable
as $$
  select role from public.profiles where user_id = auth.uid() limit 1
$$;

create or replace function public.is_role(allowed_roles public.app_role[])
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(public.current_app_role() = any(allowed_roles), false)
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_monthly_bills_updated_at on public.monthly_bills;
create trigger set_monthly_bills_updated_at
before update on public.monthly_bills
for each row execute function public.set_updated_at();

alter table public.rooms
  drop constraint if exists rooms_room_number_not_blank;

alter table public.rooms
  add constraint rooms_room_number_not_blank
  check (btrim(room_number) <> '')
  not valid;

alter table public.tenants
  drop constraint if exists tenants_name_not_blank;

alter table public.tenants
  add constraint tenants_name_not_blank
  check (btrim(name) <> '')
  not valid;

alter table public.tenants
  drop constraint if exists tenants_id_last4_format;

alter table public.tenants
  add constraint tenants_id_last4_format
  check (id_last4 is null or id_last4 ~ '^[0-9]{4}$')
  not valid;

alter table public.contracts
  drop constraint if exists contracts_amounts_nonnegative;

alter table public.contracts
  add constraint contracts_amounts_nonnegative
  check (
    monthly_rent >= 0
    and cleaning_fee >= 0
    and parking_fee >= 0
    and deposit >= 0
  )
  not valid;

alter table public.contracts
  drop constraint if exists contracts_date_order;

alter table public.contracts
  add constraint contracts_date_order
  check (
    (start_date is null or end_date is null or end_date >= start_date)
    and (move_in_date is null or move_out_date is null or move_out_date >= move_in_date)
  )
  not valid;

alter table public.monthly_bills
  drop constraint if exists monthly_bills_amounts_nonnegative;

alter table public.monthly_bills
  add constraint monthly_bills_amounts_nonnegative
  check (
    rent_amount >= 0
    and recurring_fee >= 0
    and electricity_fee >= 0
    and water_common_electricity_fee >= 0
    and misc_fee >= 0
    and total_amount >= 0
    and (transfer_amount is null or transfer_amount >= 0)
  )
  not valid;

alter table public.monthly_bills
  drop constraint if exists monthly_bills_bill_month_first_day;

alter table public.monthly_bills
  add constraint monthly_bills_bill_month_first_day
  check (bill_month = date_trunc('month', bill_month)::date)
  not valid;

alter table public.monthly_bills
  drop constraint if exists monthly_bills_transfer_last5_format;

alter table public.monthly_bills
  add constraint monthly_bills_transfer_last5_format
  check (transfer_last5 is null or transfer_last5 ~ '^[0-9]{1,5}$')
  not valid;

alter table public.monthly_bills
  drop constraint if exists monthly_bills_payment_status_method_consistency;

alter table public.monthly_bills
  add constraint monthly_bills_payment_status_method_consistency
  check (
    (payment_status = 'cash_paid' and payment_method = 'cash')
    or (payment_status in ('bank_paid', 'pending') and payment_method = 'bank_transfer')
    or (payment_status in ('vacant', 'rent_prepaid') and payment_method = 'none')
    or payment_status in ('unpaid', 'abnormal', 'partial_paid')
  )
  not valid;

alter table public.maintenance_records
  drop constraint if exists maintenance_records_cost_nonnegative;

alter table public.maintenance_records
  add constraint maintenance_records_cost_nonnegative
  check (cost >= 0)
  not valid;

create or replace function public.prevent_room_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'rooms cannot be deleted; set status to disabled instead';
end;
$$;

drop trigger if exists prevent_room_delete on public.rooms;
create trigger prevent_room_delete
before delete on public.rooms
for each row execute function public.prevent_room_delete();

create or replace function public.enforce_active_contract_room_available()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_room_status public.room_status;
begin
  if new.status = 'active' then
    select status
    into target_room_status
    from public.rooms
    where id = new.room_id;

    if target_room_status = 'disabled' then
      raise exception 'cannot create active contract for a disabled room';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_active_contract_room_available on public.contracts;
create trigger enforce_active_contract_room_available
before insert or update on public.contracts
for each row execute function public.enforce_active_contract_room_available();

create or replace function public.enforce_monthly_bill_role_permissions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_role public.app_role;
begin
  actor_role := public.current_app_role();

  if actor_role = 'super_admin' then
    return new;
  end if;

  if actor_role = 'accountant_a' then
    if old.payment_method = 'cash' then
      raise exception 'accountant_a cannot modify cash collection bills';
    end if;

    if new.room_id is distinct from old.room_id
      or new.contract_id is distinct from old.contract_id
      or new.bill_month is distinct from old.bill_month
      or new.rent_amount is distinct from old.rent_amount
      or new.recurring_fee is distinct from old.recurring_fee
      or new.electricity_fee is distinct from old.electricity_fee
      or new.water_common_electricity_fee is distinct from old.water_common_electricity_fee
      or new.misc_fee is distinct from old.misc_fee
      or new.total_amount is distinct from old.total_amount
      or new.created_at is distinct from old.created_at then
      raise exception 'accountant_a can only edit bank transfer fields';
    end if;

    if new.payment_method not in ('bank_transfer', 'none') then
      raise exception 'accountant_a can only set bank transfer payment method';
    end if;

    return new;
  end if;

  if actor_role = 'cash_collector_b' then
    if old.payment_method <> 'cash' then
      raise exception 'cash_collector_b can only edit cash bills';
    end if;

    if new.room_id is distinct from old.room_id
      or new.contract_id is distinct from old.contract_id
      or new.bill_month is distinct from old.bill_month
      or new.rent_amount is distinct from old.rent_amount
      or new.recurring_fee is distinct from old.recurring_fee
      or new.electricity_fee is distinct from old.electricity_fee
      or new.water_common_electricity_fee is distinct from old.water_common_electricity_fee
      or new.misc_fee is distinct from old.misc_fee
      or new.total_amount is distinct from old.total_amount
      or new.payment_method is distinct from old.payment_method
      or new.transfer_last5 is distinct from old.transfer_last5
      or new.transfer_amount is distinct from old.transfer_amount
      or new.created_at is distinct from old.created_at then
      raise exception 'cash_collector_b can only confirm cash payment';
    end if;

    if new.payment_status <> 'cash_paid' then
      raise exception 'cash_collector_b can only mark bills as cash_paid';
    end if;

    return new;
  end if;

  raise exception 'viewer cannot update monthly bills';
end;
$$;

drop trigger if exists enforce_monthly_bill_role_permissions on public.monthly_bills;
create trigger enforce_monthly_bill_role_permissions
before update on public.monthly_bills
for each row execute function public.enforce_monthly_bill_role_permissions();

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

alter table public.rooms enable row level security;
alter table public.tenants enable row level security;
alter table public.contracts enable row level security;
alter table public.monthly_bills enable row level security;
alter table public.maintenance_records enable row level security;
alter table public.profiles enable row level security;
alter table public.monthly_locks enable row level security;
alter table public.audit_logs enable row level security;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
for select using (
  user_id = auth.uid()
  or public.is_role(array['super_admin']::public.app_role[])
);

drop policy if exists profiles_insert_own_viewer on public.profiles;
create policy profiles_insert_own_viewer on public.profiles
for insert with check (
  user_id = auth.uid()
  and role = 'viewer'
);

drop policy if exists profiles_super_admin_manage on public.profiles;
create policy profiles_super_admin_manage on public.profiles
for all using (public.is_role(array['super_admin']::public.app_role[]))
with check (public.is_role(array['super_admin']::public.app_role[]));

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

drop policy if exists rooms_select on public.rooms;
create policy rooms_select on public.rooms
for select using (
  public.is_role(array['super_admin','accountant_a','viewer']::public.app_role[])
  or (
    public.current_app_role() = 'cash_collector_b'
    and exists (
      select 1 from public.monthly_bills mb
      where mb.room_id = rooms.id and mb.payment_method = 'cash'
    )
  )
);

drop policy if exists rooms_super_admin_manage on public.rooms;
create policy rooms_super_admin_manage on public.rooms
for all using (public.is_role(array['super_admin']::public.app_role[]))
with check (public.is_role(array['super_admin']::public.app_role[]));

drop policy if exists tenants_select on public.tenants;
create policy tenants_select on public.tenants
for select using (
  public.is_role(array['super_admin','accountant_a','viewer']::public.app_role[])
  or (
    public.current_app_role() = 'cash_collector_b'
    and exists (
      select 1
      from public.contracts c
      join public.monthly_bills mb on mb.contract_id = c.id
      where c.tenant_id = tenants.id and mb.payment_method = 'cash'
    )
  )
);

drop policy if exists tenants_super_admin_manage on public.tenants;
create policy tenants_super_admin_manage on public.tenants
for all using (public.is_role(array['super_admin']::public.app_role[]))
with check (public.is_role(array['super_admin']::public.app_role[]));

drop policy if exists contracts_select on public.contracts;
create policy contracts_select on public.contracts
for select using (
  public.is_role(array['super_admin','accountant_a','viewer']::public.app_role[])
  or (
    public.current_app_role() = 'cash_collector_b'
    and exists (
      select 1 from public.monthly_bills mb
      where mb.contract_id = contracts.id and mb.payment_method = 'cash'
    )
  )
);

drop policy if exists contracts_super_admin_manage on public.contracts;
create policy contracts_super_admin_manage on public.contracts
for all using (public.is_role(array['super_admin']::public.app_role[]))
with check (public.is_role(array['super_admin']::public.app_role[]));

drop policy if exists monthly_bills_select on public.monthly_bills;
create policy monthly_bills_select on public.monthly_bills
for select using (
  public.is_role(array['super_admin','accountant_a','viewer']::public.app_role[])
  or (public.current_app_role() = 'cash_collector_b' and payment_method = 'cash')
);

drop policy if exists monthly_bills_super_admin_insert_delete on public.monthly_bills;
create policy monthly_bills_super_admin_insert_delete on public.monthly_bills
for all using (public.is_role(array['super_admin']::public.app_role[]))
with check (public.is_role(array['super_admin']::public.app_role[]));

drop policy if exists monthly_bills_accountant_update on public.monthly_bills;
create policy monthly_bills_accountant_update on public.monthly_bills
for update using (public.current_app_role() = 'accountant_a')
with check (public.current_app_role() = 'accountant_a');

drop policy if exists monthly_bills_cash_update on public.monthly_bills;
create policy monthly_bills_cash_update on public.monthly_bills
for update using (
  public.current_app_role() = 'cash_collector_b'
  and payment_method = 'cash'
)
with check (
  public.current_app_role() = 'cash_collector_b'
  and payment_method = 'cash'
);

drop policy if exists maintenance_records_select on public.maintenance_records;
create policy maintenance_records_select on public.maintenance_records
for select using (
  public.is_role(array['super_admin','accountant_a','viewer']::public.app_role[])
  or (
    public.current_app_role() = 'cash_collector_b'
    and exists (
      select 1 from public.monthly_bills mb
      where mb.room_id = maintenance_records.room_id and mb.payment_method = 'cash'
    )
  )
);

drop policy if exists maintenance_records_super_admin_manage on public.maintenance_records;
create policy maintenance_records_super_admin_manage on public.maintenance_records
for all using (public.is_role(array['super_admin']::public.app_role[]))
with check (public.is_role(array['super_admin']::public.app_role[]));

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
