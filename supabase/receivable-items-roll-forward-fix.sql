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
settled_roll_forward as (
  select
    mb.id,
    greatest(mb.total_amount + ba.arrears_amount - coalesce(mb.transfer_amount, 0), 0) as unpaid_amount
  from public.monthly_bills mb
  join bill_arrears ba on ba.bill_id = mb.id
  where mb.payment_status::text = 'partial_paid'
)
update public.receivable_items ri
set
  amount = 0,
  paid_amount = 0,
  status = 'settled',
  note = '已結清不順延',
  updated_at = now()
from settled_roll_forward s
where ri.source_bill_id = s.id
  and s.unpaid_amount = 0;

notify pgrst, 'reload schema';
