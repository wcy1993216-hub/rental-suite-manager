alter table public.monthly_bills
  add column if not exists recurring_fee numeric(12, 2) not null default 0;

alter table public.monthly_bills
  disable trigger enforce_monthly_bill_role_permissions;

update public.monthly_bills
set
  recurring_fee = misc_fee,
  misc_fee = 0,
  total_amount = rent_amount + misc_fee + electricity_fee
where recurring_fee = 0
  and misc_fee <> 0;

alter table public.monthly_bills
  enable trigger enforce_monthly_bill_role_permissions;
