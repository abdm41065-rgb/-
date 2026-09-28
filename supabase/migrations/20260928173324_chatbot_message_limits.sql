create table if not exists public.chat_usage (
  client_hash text primary key,
  message_count smallint not null default 0 check (message_count between 0 and 15),
  updated_at timestamptz not null default now()
);

alter table public.chat_usage enable row level security;
revoke all on table public.chat_usage from anon, authenticated;

create or replace function public.consume_chat_message(
  p_client_hash text,
  p_limit integer default 15
)
returns table (allowed boolean, used integer, remaining integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_count integer;
begin
  if p_client_hash is null or length(p_client_hash) <> 64 then
    raise exception 'invalid client hash';
  end if;

  insert into public.chat_usage as usage (client_hash, message_count, updated_at)
  values (p_client_hash, 1, now())
  on conflict (client_hash) do update
    set message_count = usage.message_count + 1,
        updated_at = now()
    where usage.message_count < least(greatest(p_limit, 1), 15)
  returning message_count into current_count;

  if current_count is null then
    select message_count into current_count
    from public.chat_usage
    where client_hash = p_client_hash;

    return query select false, current_count, 0;
    return;
  end if;

  return query
  select true, current_count, greatest(least(greatest(p_limit, 1), 15) - current_count, 0);
end;
$$;

revoke all on function public.consume_chat_message(text, integer) from public, anon, authenticated;
grant execute on function public.consume_chat_message(text, integer) to service_role;
