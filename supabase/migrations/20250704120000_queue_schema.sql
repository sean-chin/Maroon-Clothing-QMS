-- Maroon queue: shared Postgres state for serverless / multi-instance hosting.
-- Access only via service role from the Express server (RLS enabled, no public policies).

create table if not exists public.queue_settings (
  id integer primary key default 1 check (id = 1),
  seq integer not null default 0,
  open boolean not null default true
);

insert into public.queue_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.guests (
  id uuid primary key,
  token text not null unique,
  number integer not null,
  name text not null,
  status text not null default 'waiting',
  joined_at bigint not null,
  called_at bigint,
  email text,
  push_sub jsonb,
  heads_up_sent boolean not null default false,
  constraint guests_status_check check (
    status in ('waiting', 'called', 'inStore', 'done', 'noShow')
  )
);

create index if not exists guests_token_idx on public.guests (token);
create index if not exists guests_status_idx on public.guests (status);
create index if not exists guests_active_number_idx on public.guests (number)
  where status in ('waiting', 'called', 'inStore');

alter table public.queue_settings enable row level security;
alter table public.guests enable row level security;

-- Atomic join: increments seq and inserts guest under row lock.
create or replace function public.maroon_join_guest(
  p_id uuid,
  p_token text,
  p_name text,
  p_email text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_open boolean;
  v_seq integer;
  v_count integer;
  v_row guests%rowtype;
begin
  select open, seq into v_open, v_seq from queue_settings where id = 1 for update;
  if not coalesce(v_open, false) then
    raise exception 'queue_closed';
  end if;
  select count(*)::integer into v_count from guests
    where status in ('waiting', 'called', 'inStore');
  if v_count >= 5000 then
    raise exception 'queue_full';
  end if;
  v_seq := v_seq + 1;
  update queue_settings set seq = v_seq where id = 1;
  insert into guests (id, token, number, name, status, joined_at, email, heads_up_sent)
  values (
    p_id,
    p_token,
    v_seq,
    p_name,
    'waiting',
    (floor(extract(epoch from clock_timestamp()) * 1000))::bigint,
    p_email,
    false
  )
  returning * into v_row;
  return jsonb_build_object(
    'id', v_row.id,
    'token', v_row.token,
    'number', v_row.number,
    'name', v_row.name,
    'status', v_row.status,
    'joinedAt', v_row.joined_at,
    'calledAt', v_row.called_at,
    'email', v_row.email,
    'pushSub', v_row.push_sub,
    'headsUpSent', v_row.heads_up_sent
  );
end;
$$;

-- Call the next N waiting guests when store capacity allows.
create or replace function public.maroon_call_next(
  p_count integer,
  p_capacity integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_in_store integer;
  v_called integer;
  v_room integer;
  v_to_call integer;
  v_ids uuid[];
  v_numbers integer[];
begin
  select count(*)::integer into v_in_store from guests where status = 'inStore';
  select count(*)::integer into v_called from guests where status = 'called';
  v_room := greatest(0, p_capacity - v_in_store - v_called);
  if v_room <= 0 then
    raise exception 'store_full';
  end if;
  v_to_call := least(greatest(p_count, 1), v_room, 50);

  select array_agg(id order by number), array_agg(number order by number)
  into v_ids, v_numbers
  from (
    select id, number from guests
    where status = 'waiting'
    order by number
    limit v_to_call
    for update skip locked
  ) w;

  if v_ids is null or array_length(v_ids, 1) is null then
    return '[]'::jsonb;
  end if;

  update guests set
    status = 'called',
    called_at = (floor(extract(epoch from clock_timestamp()) * 1000))::bigint,
    heads_up_sent = true
  where id = any (v_ids);

  return to_jsonb(v_numbers);
end;
$$;

-- Wipe queue for a fresh event day.
create or replace function public.maroon_reset_queue()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- `where true` is required: Supabase's safeupdate guard (preloaded on the
  -- authenticator role PostgREST/RPC uses) blocks DELETE/UPDATE without a
  -- WHERE clause, even nested inside a SECURITY DEFINER function.
  delete from guests where true;
  update queue_settings set seq = 0, open = true where id = 1;
end;
$$;

-- Server-only access: Express uses SUPABASE_SERVICE_ROLE_KEY (never expose to browsers).
revoke all on table public.queue_settings from anon, authenticated;
revoke all on table public.guests from anon, authenticated;
revoke all on function public.maroon_join_guest(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.maroon_call_next(integer, integer) from public, anon, authenticated;
revoke all on function public.maroon_reset_queue() from public, anon, authenticated;
grant all on table public.queue_settings to service_role;
grant all on table public.guests to service_role;
grant execute on function public.maroon_join_guest(uuid, text, text, text) to service_role;
grant execute on function public.maroon_call_next(integer, integer) to service_role;
grant execute on function public.maroon_reset_queue() to service_role;
