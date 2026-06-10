alter type public.payment_status add value if not exists 'partial_paid';

alter table public.monthly_bills
  drop constraint if exists monthly_bills_payment_status_method_consistency;

alter table public.monthly_bills
  add constraint monthly_bills_payment_status_method_consistency
  check (
    (payment_status::text = 'cash_paid' and payment_method = 'cash')
    or (payment_status::text in ('bank_paid', 'pending') and payment_method = 'bank_transfer')
    or (payment_status::text in ('vacant', 'rent_prepaid') and payment_method = 'none')
    or payment_status::text in ('unpaid', 'abnormal', 'partial_paid')
  )
  not valid;

notify pgrst, 'reload schema';
