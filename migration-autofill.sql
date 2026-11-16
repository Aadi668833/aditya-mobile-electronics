-- Aditya Mobile & Electronics: Auto-fill upgrade.
-- Run ONCE in Supabase > SQL Editor (after schema.sql). Safe for existing data:
-- it only ADDS optional columns, a duplicate guard, and a discount-aware price in billing.
-- Tip: before running, download a backup (Table Editor > products > Export CSV).

-- 1) New optional product fields
alter table products add column if not exists discount_price numeric(12,2);
alter table products add column if not exists colors text;
alter table products add column if not exists image_credit text;   -- photo credit/licence when an openly licensed photo is used

do $$ begin
  if not exists (select 1 from pg_constraint where conname='products_discount_ck') then
    alter table products add constraint products_discount_ck
      check (discount_price is null or (discount_price>=0 and discount_price<=price));
  end if;
end $$;

-- 2) Duplicate guard: two products cannot have the same name (ignoring spaces, case and symbols).
-- If you already have duplicates, the index is skipped with a notice; rename them and run this block again.
alter table products add column if not exists dedupe_key text
  generated always as (lower(regexp_replace(name,'[^a-zA-Z0-9]+','','g'))) stored;
do $$ begin
  create unique index if not exists products_dedupe_uq on products(dedupe_key);
exception when unique_violation then
  raise notice 'Duplicate product names already exist, so the duplicate guard was NOT created. Rename the duplicates, then run this block again.';
end $$;

-- 3) Public website view: adds discount price, colours and photo credit (still no cost price, supplier, SKU/IMEI or exact quantity)
create or replace view public_products as
  select id,name,brand,model,category,description,specs,image_url,price,(qty>0) as in_stock,
         discount_price,colors,image_credit
  from products where listed;
grant select on public_products to anon, authenticated;

-- 4) Billing uses the discount price when one is set (identical behaviour when it is empty)
create or replace function create_sale(p_items jsonb,p_discount numeric,p_paid numeric,p_method text,p_name text,p_phone text,p_key text)
returns uuid language plpgsql security definer set search_path=public as $$
declare sid uuid; it jsonb; pr products; sub numeric:=0; tot numeric; n int; unit numeric;
begin
  if not is_admin() then raise exception 'Not allowed'; end if;
  select id into sid from sales where idem_key=p_key; if found then return sid; end if;
  if jsonb_array_length(p_items)=0 then raise exception 'Add at least one item'; end if;
  insert into sales(idem_key,invoice_no,customer_name,customer_phone,subtotal,discount,total,paid,method)
  values(p_key,'INV-'||to_char(now(),'YYMM')||'-'||lpad(nextval('invoice_seq')::text,5,'0'),p_name,p_phone,0,0,0,0,p_method) returning id into sid;
  for it in select * from jsonb_array_elements(p_items) loop
    n:=(it->>'qty')::int;
    select * into pr from products where id=(it->>'id')::uuid for update;
    if not found or n<=0 then raise exception 'Invalid item'; end if;
    if pr.qty<n then raise exception 'Not enough stock for % (only % left)',pr.name,pr.qty; end if;
    unit:=coalesce(pr.discount_price,pr.price);
    update products set qty=qty-n where id=pr.id;
    insert into sale_items(sale_id,product_id,name,qty,price,cost) values(sid,pr.id,pr.name,n,unit,pr.purchase_price);
    sub:=sub+unit*n;
  end loop;
  if p_discount<0 or p_discount>sub then raise exception 'Discount must be between 0 and the subtotal'; end if;
  tot:=sub-p_discount;
  if p_paid<0 or p_paid>tot then raise exception 'Paid amount must be between 0 and the total'; end if;
  update sales set subtotal=sub,discount=p_discount,total=tot,paid=p_paid where id=sid;
  insert into activity_log(actor,action,detail) values(auth.uid(),'sale',jsonb_build_object('sale',sid,'total',tot));
  return sid;
end $$;
