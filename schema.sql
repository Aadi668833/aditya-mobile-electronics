-- Aditya Mobile & Electronics: run once in Supabase > SQL Editor
create extension if not exists pgcrypto;

create table admins(user_id uuid primary key references auth.users on delete cascade);
create function is_admin() returns boolean language sql stable security definer set search_path=public
as $$ select exists(select 1 from admins where user_id=auth.uid()) $$;

create table suppliers(id uuid primary key default gen_random_uuid(), name text unique not null, phone text, created_at timestamptz default now());
create table products(
  id uuid primary key default gen_random_uuid(),
  name text not null, brand text, model text,
  category text not null check (category in ('Mobile Phones','Accessories','Electronics')),
  sku text unique, barcode text, imei text, description text, specs text, image_url text,
  purchase_price numeric(12,2) not null default 0 check (purchase_price>=0),
  price numeric(12,2) not null check (price>=0),
  qty int not null default 0 check (qty>=0),            -- stock can never go negative
  low_stock int not null default 3 check (low_stock>=0),
  supplier_id uuid references suppliers, purchase_date date,
  listed boolean not null default true, created_at timestamptz default now());
create table purchases(
  id uuid primary key default gen_random_uuid(), idem_key text unique,
  product_id uuid not null references products, supplier_id uuid references suppliers,
  qty int not null check (qty>0), unit_cost numeric(12,2) not null check (unit_cost>=0),
  total numeric(12,2) not null, purchase_date date not null default current_date, created_at timestamptz default now());
create sequence invoice_seq;
create table sales(
  id uuid primary key default gen_random_uuid(), invoice_no text unique, idem_key text unique,
  customer_name text, customer_phone text,
  subtotal numeric(12,2) not null, discount numeric(12,2) not null default 0,
  total numeric(12,2) not null, paid numeric(12,2) not null default 0,
  method text not null default 'Cash', created_at timestamptz default now(), created_by uuid default auth.uid(),
  check (paid>=0 and paid<=total));
create table sale_items(
  id uuid primary key default gen_random_uuid(), sale_id uuid not null references sales on delete cascade,
  product_id uuid not null references products, name text not null,
  qty int not null check (qty>0), price numeric(12,2) not null, cost numeric(12,2) not null);
create table activity_log(id bigserial primary key, at timestamptz default now(), actor uuid, action text, detail jsonb);

-- Row-level security: only admins touch anything. Public gets ONE safe view (below).
alter table admins enable row level security;
alter table suppliers enable row level security;
alter table products enable row level security;
alter table purchases enable row level security;
alter table sales enable row level security;
alter table sale_items enable row level security;
alter table activity_log enable row level security;
create policy own_row on admins for select using (user_id=auth.uid());
create policy adm_all on suppliers for all using (is_admin()) with check (is_admin());
create policy adm_all on products  for all using (is_admin()) with check (is_admin());
create policy adm_read on purchases for select using (is_admin());   -- writes only via functions
create policy adm_read on sales for select using (is_admin());
create policy adm_read on sale_items for select using (is_admin());
create policy adm_read on activity_log for select using (is_admin());

-- Public catalog: no purchase price, supplier, SKU/IMEI or exact quantity.
create view public_products as
  select id,name,brand,model,category,description,specs,image_url,price,(qty>0) as in_stock
  from products where listed;

-- Log every product change (including stock changes)
create function log_product() returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into activity_log(actor,action,detail) values(auth.uid(),'product_'||lower(tg_op),jsonb_build_object(
    'name',coalesce(to_jsonb(new)->>'name',to_jsonb(old)->>'name'),
    'old_qty',to_jsonb(old)->'qty','new_qty',to_jsonb(new)->'qty',
    'old_price',to_jsonb(old)->'price','new_price',to_jsonb(new)->'price'));
  return coalesce(new,old);
end $$;
create trigger trg_log after insert or update or delete on products for each row execute function log_product();

-- Sale: one atomic transaction; locks rows; refuses overselling; safe to retry (idempotency key)
create function create_sale(p_items jsonb,p_discount numeric,p_paid numeric,p_method text,p_name text,p_phone text,p_key text)
returns uuid language plpgsql security definer set search_path=public as $$
declare sid uuid; it jsonb; pr products; sub numeric:=0; tot numeric; n int;
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
    update products set qty=qty-n where id=pr.id;
    insert into sale_items(sale_id,product_id,name,qty,price,cost) values(sid,pr.id,pr.name,n,pr.price,pr.purchase_price);
    sub:=sub+pr.price*n;
  end loop;
  if p_discount<0 or p_discount>sub then raise exception 'Discount must be between 0 and the subtotal'; end if;
  tot:=sub-p_discount;
  if p_paid<0 or p_paid>tot then raise exception 'Paid amount must be between 0 and the total'; end if;
  update sales set subtotal=sub,discount=p_discount,total=tot,paid=p_paid where id=sid;
  insert into activity_log(actor,action,detail) values(auth.uid(),'sale',jsonb_build_object('sale',sid,'total',tot));
  return sid;
end $$;

create function record_purchase(p_product uuid,p_supplier text,p_phone text,p_qty int,p_cost numeric,p_date date,p_key text)
returns void language plpgsql security definer set search_path=public as $$
declare sup uuid;
begin
  if not is_admin() then raise exception 'Not allowed'; end if;
  if exists(select 1 from purchases where idem_key=p_key) then return; end if;
  if p_qty<=0 or p_cost<0 then raise exception 'Enter a quantity above 0 and a valid cost'; end if;
  if coalesce(trim(p_supplier),'')<>'' then
    insert into suppliers(name,phone) values(trim(p_supplier),p_phone)
    on conflict(name) do update set phone=coalesce(excluded.phone,suppliers.phone) returning id into sup;
  end if;
  insert into purchases(idem_key,product_id,supplier_id,qty,unit_cost,total,purchase_date) values(p_key,p_product,sup,p_qty,p_cost,p_qty*p_cost,p_date);
  update products set qty=qty+p_qty,purchase_price=p_cost,purchase_date=p_date,supplier_id=coalesce(sup,supplier_id) where id=p_product;
  insert into activity_log(actor,action,detail) values(auth.uid(),'purchase',jsonb_build_object('product',p_product,'qty',p_qty,'cost',p_cost));
end $$;

create function adjust_stock(p_product uuid,p_qty int,p_reason text)
returns void language plpgsql security definer set search_path=public as $$
declare o int;
begin
  if not is_admin() then raise exception 'Not allowed'; end if;
  if p_qty<0 then raise exception 'Stock cannot be negative'; end if;
  if coalesce(trim(p_reason),'')='' then raise exception 'Please give a reason'; end if;
  select qty into o from products where id=p_product for update;
  update products set qty=p_qty where id=p_product;
  insert into activity_log(actor,action,detail) values(auth.uid(),'stock_adjust',jsonb_build_object('product',p_product,'from',o,'to',p_qty,'reason',p_reason));
end $$;

create function add_payment(p_sale uuid,p_amount numeric)
returns void language plpgsql security definer set search_path=public as $$
begin
  if not is_admin() then raise exception 'Not allowed'; end if;
  update sales set paid=paid+p_amount where id=p_sale and p_amount>0 and paid+p_amount<=total;
  if not found then raise exception 'Payment must be above 0 and not more than the balance due'; end if;
  insert into activity_log(actor,action,detail) values(auth.uid(),'payment',jsonb_build_object('sale',p_sale,'amount',p_amount));
end $$;

-- Image storage: anyone can view product photos; only admins can upload/change
insert into storage.buckets(id,name,public) values('product-images','product-images',true) on conflict do nothing;
create policy img_read on storage.objects for select using (bucket_id='product-images');
create policy img_write on storage.objects for insert with check (bucket_id='product-images' and is_admin());
create policy img_upd on storage.objects for update using (bucket_id='product-images' and is_admin());
create policy img_del on storage.objects for delete using (bucket_id='product-images' and is_admin());

-- Lock down the public (anon) role: it may read only the safe view
revoke all on all tables in schema public from anon;
revoke execute on all functions in schema public from public, anon;
grant select on public_products to anon, authenticated;
grant execute on all functions in schema public to authenticated;
