create unique index if not exists idx_monthly_bills_one_per_room_month
on public.monthly_bills(room_id, bill_month);

create unique index if not exists idx_contracts_one_active_per_room
on public.contracts(room_id)
where status = 'active';

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
