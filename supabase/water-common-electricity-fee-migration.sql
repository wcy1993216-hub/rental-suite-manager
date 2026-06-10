alter table public.monthly_bills
  add column if not exists water_common_electricity_fee numeric(12, 2) not null default 0;

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
