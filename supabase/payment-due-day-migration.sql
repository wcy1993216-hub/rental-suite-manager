alter table public.contracts
  add column if not exists payment_due_day integer;

alter table public.contracts
  drop constraint if exists contracts_payment_due_day_check;

alter table public.contracts
  add constraint contracts_payment_due_day_check
  check (payment_due_day is null or (payment_due_day >= 1 and payment_due_day <= 31));
