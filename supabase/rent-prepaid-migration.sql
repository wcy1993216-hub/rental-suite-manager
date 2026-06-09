do $$ begin
  create type public.rent_payment_cycle as enum ('monthly', 'semiannual', 'annual');
exception when duplicate_object then null;
end $$;

alter table public.contracts
  add column if not exists rent_payment_cycle public.rent_payment_cycle not null default 'monthly';

alter table public.contracts
  add column if not exists rent_paid_until date;
