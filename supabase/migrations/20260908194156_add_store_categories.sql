create table if not exists public.store_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (char_length(name) between 2 and 60),
  sort_order integer not null default 0 check (sort_order between 0 and 999),
  created_at timestamptz not null default now()
);

alter table public.store_categories enable row level security;

drop policy if exists "categories_public_read" on public.store_categories;
create policy "categories_public_read" on public.store_categories
for select to anon, authenticated using (true);

grant select on public.store_categories to anon, authenticated;
revoke insert, update, delete on public.store_categories from anon, authenticated;

insert into public.store_categories (name, sort_order)
select category, row_number() over (order by category)::integer * 10
from (select distinct category from public.products where category is not null and btrim(category) <> '') s
on conflict (name) do nothing;

create or replace function public.admin_save_category(session_token text, payload jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  category_id uuid;
  category_name text;
  category_order integer;
  previous_name text;
  saved public.store_categories;
begin
  if not public.admin_session_valid(session_token) then raise exception 'unauthorized'; end if;
  category_name := btrim(payload->>'name');
  category_order := greatest(0, least(999, coalesce((payload->>'sort_order')::integer, 0)));
  if category_name is null or char_length(category_name) not between 2 and 60 then raise exception 'invalid category'; end if;

  if nullif(payload->>'id', '') is null then
    insert into public.store_categories (name, sort_order) values (category_name, category_order) returning * into saved;
  else
    category_id := (payload->>'id')::uuid;
    select name into previous_name from public.store_categories where id = category_id;
    if previous_name is null then raise exception 'category not found'; end if;
    update public.store_categories set name = category_name, sort_order = category_order where id = category_id returning * into saved;
    update public.products set category = category_name where category = previous_name;
  end if;
  return to_jsonb(saved);
end;
$$;

create or replace function public.admin_delete_category(session_token text, category_id uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp
as $$
declare category_name text;
begin
  if not public.admin_session_valid(session_token) then raise exception 'unauthorized'; end if;
  select name into category_name from public.store_categories where id = category_id;
  if category_name is null then return false; end if;
  if exists (select 1 from public.products where category = category_name) then raise exception 'category in use'; end if;
  delete from public.store_categories where id = category_id;
  return true;
end;
$$;

revoke all on function public.admin_save_category(text, jsonb) from public;
revoke all on function public.admin_delete_category(text, uuid) from public;
grant execute on function public.admin_save_category(text, jsonb) to anon, authenticated;
grant execute on function public.admin_delete_category(text, uuid) to anon, authenticated;
