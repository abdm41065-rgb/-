create extension if not exists pg_trgm with schema extensions;

create index if not exists products_catalog_page_idx
  on public.products (category, created_at desc, id desc);
create index if not exists products_created_page_idx
  on public.products (created_at desc, id desc);
create index if not exists products_featured_page_idx
  on public.products (created_at desc, id desc) where featured = true;
create index if not exists products_search_idx
  on public.products using gin (
    (lower(name || ' ' || category || ' ' || description)) extensions.gin_trgm_ops
  );
create index if not exists orders_status_created_idx
  on public.orders (status, created_at desc, id desc);

drop policy if exists "Authenticated users manage products" on public.products;
drop policy if exists "Admin manages orders" on public.orders;
drop policy if exists "Public can view products" on public.products;
create policy "Public can view products" on public.products
  for select to anon, authenticated using (true);

create or replace function public.catalog_products(
  search_text text default null,
  category_filter text default null,
  page_size integer default 24,
  page_offset integer default 0
)
returns setof public.products
language sql
stable
security invoker
set search_path = ''
as $$
  select p.*
  from public.products p
  where (nullif(btrim(category_filter), '') is null or p.category = category_filter)
    and (
      nullif(btrim(search_text), '') is null
      or lower(p.name || ' ' || p.category || ' ' || p.description)
        like '%' || lower(btrim(search_text)) || '%'
    )
  order by p.created_at desc, p.id desc
  limit least(greatest(page_size, 1), 60)
  offset greatest(page_offset, 0);
$$;

revoke all on function public.catalog_products(text, text, integer, integer) from public;
grant execute on function public.catalog_products(text, text, integer, integer) to anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'product-images',
  'product-images',
  true,
  2097152,
  array['image/jpeg','image/png','image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Public product images" on storage.objects;
create policy "Public product images" on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'product-images');
