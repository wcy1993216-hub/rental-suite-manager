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
  create type public.payment_status as enum ('unpaid', 'bank_paid', 'cash_paid', 'pending', 'abnormal', 'vacant', 'rent_prepaid');
exception when duplicate_object then null;
end $$;

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

create index if not exists idx_monthly_bills_bill_month on public.monthly_bills(bill_month);
create index if not exists idx_monthly_bills_payment_status on public.monthly_bills(payment_status);
create index if not exists idx_monthly_bills_payment_method on public.monthly_bills(payment_method);
create index if not exists idx_contracts_room_status on public.contracts(room_id, status);
create unique index if not exists idx_contracts_one_active_per_room on public.contracts(room_id) where status = 'active';
create index if not exists idx_maintenance_records_room on public.maintenance_records(room_id);

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

alter table public.rooms enable row level security;
alter table public.tenants enable row level security;
alter table public.contracts enable row level security;
alter table public.monthly_bills enable row level security;
alter table public.maintenance_records enable row level security;
alter table public.profiles enable row level security;

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
