delete from public.maintenance_records
where room_id in (
  select id
  from public.rooms
  where room_number in ('115年0月現金收租表', '115年0月现金收租表', '房號', '房号')
     or room_number like '%收租表%'
);

delete from public.monthly_bills
where room_id in (
  select id
  from public.rooms
  where room_number in ('115年0月現金收租表', '115年0月现金收租表', '房號', '房号')
     or room_number like '%收租表%'
);

delete from public.contracts
where room_id in (
  select id
  from public.rooms
  where room_number in ('115年0月現金收租表', '115年0月现金收租表', '房號', '房号')
     or room_number like '%收租表%'
);

delete from public.tenants
where name in ('115年0月現金收租表', '115年0月现金收租表', '姓名')
  and not exists (
    select 1
    from public.contracts
    where contracts.tenant_id = tenants.id
  );

delete from public.rooms
where room_number in ('115年0月現金收租表', '115年0月现金收租表', '房號', '房号')
   or room_number like '%收租表%';
