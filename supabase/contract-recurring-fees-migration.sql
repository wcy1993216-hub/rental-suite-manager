alter table public.contracts
  add column if not exists cleaning_fee numeric(12, 2) not null default 0;

alter table public.contracts
  add column if not exists parking_fee numeric(12, 2) not null default 0;
