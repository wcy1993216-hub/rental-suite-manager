create table if not exists public.receivable_items (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete restrict,
  contract_id uuid references public.contracts(id) on delete set null,
  source_bill_id uuid references public.monthly_bills(id) on delete set null,
  source_bill_month date not null,
  due_bill_month date not null,
  amount numeric(12, 2) not null default 0,
  paid_amount numeric(12, 2) not null default 0,
  status text not null default 'open',
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_bill_id)
);

create index if not exists idx_receivable_items_room_due
on public.receivable_items(room_id, due_bill_month);

create index if not exists idx_receivable_items_status
on public.receivable_items(status);

alter table public.receivable_items
  drop constraint if exists receivable_items_amounts_nonnegative;

alter table public.receivable_items
  add constraint receivable_items_amounts_nonnegative
  check (
    amount >= 0
    and paid_amount >= 0
    and paid_amount <= amount
  )
  not valid;

alter table public.receivable_items
  drop constraint if exists receivable_items_status_check;

alter table public.receivable_items
  add constraint receivable_items_status_check
  check (status in ('open', 'settled', 'waived'))
  not valid;

drop trigger if exists set_receivable_items_updated_at on public.receivable_items;
create trigger set_receivable_items_updated_at
before update on public.receivable_items
for each row execute function public.set_updated_at();

alter table public.receivable_items enable row level security;

drop policy if exists receivable_items_select on public.receivable_items;
create policy receivable_items_select on public.receivable_items
for select using (
  public.is_role(array['super_admin','accountant_a','viewer']::public.app_role[])
  or public.current_app_role() = 'cash_collector_b'
);

drop policy if exists receivable_items_super_admin_manage on public.receivable_items;
create policy receivable_items_super_admin_manage on public.receivable_items
for all using (public.is_role(array['super_admin']::public.app_role[]))
with check (public.is_role(array['super_admin']::public.app_role[]));

drop policy if exists receivable_items_accountant_insert on public.receivable_items;
create policy receivable_items_accountant_insert on public.receivable_items
for insert with check (public.current_app_role() = 'accountant_a');

drop policy if exists receivable_items_accountant_update on public.receivable_items;
create policy receivable_items_accountant_update on public.receivable_items
for update using (public.current_app_role() = 'accountant_a')
with check (public.current_app_role() = 'accountant_a');

drop policy if exists receivable_items_cash_update on public.receivable_items;
create policy receivable_items_cash_update on public.receivable_items
for update using (public.current_app_role() = 'cash_collector_b')
with check (public.current_app_role() = 'cash_collector_b');

with bill_arrears as (
  select
    mb.id as bill_id,
    coalesce(sum(ri.amount), 0) as arrears_amount
  from public.monthly_bills mb
  left join public.receivable_items ri
    on ri.room_id = mb.room_id
    and (ri.contract_id is null or ri.contract_id = mb.contract_id)
    and ri.due_bill_month = mb.bill_month
    and ri.status <> 'waived'
    and (ri.source_bill_id is null or ri.source_bill_id <> mb.id)
  group by mb.id
),
partial_roll_forward as (
  select
    mb.id,
    mb.room_id,
    mb.contract_id,
    mb.bill_month,
    greatest(mb.total_amount + ba.arrears_amount - coalesce(mb.transfer_amount, 0), 0) as unpaid_amount
  from public.monthly_bills mb
  join bill_arrears ba on ba.bill_id = mb.id
  where mb.payment_status::text = 'partial_paid'
)
insert into public.receivable_items (
  room_id,
  contract_id,
  source_bill_id,
  source_bill_month,
  due_bill_month,
  amount,
  paid_amount,
  status,
  note
)
select
  room_id,
  contract_id,
  id,
  bill_month,
  (date_trunc('month', bill_month) + interval '1 month')::date,
  unpaid_amount,
  0,
  'open',
  '部分收款順延'
from partial_roll_forward
where unpaid_amount > 0
on conflict (source_bill_id) do update
set
  amount = excluded.amount,
  paid_amount = least(receivable_items.paid_amount, excluded.amount),
  status = 'open',
  note = excluded.note,
  updated_at = now();

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'receivable_items'
    ) then
      execute 'alter publication supabase_realtime add table public.receivable_items';
    end if;
  end if;
end $$;

notify pgrst, 'reload schema';
