-- Fixed-window rate limiting shared across all server instances. An
-- in-memory limiter only works per-process, which is meaningless on
-- serverless hosts (Vercel) where every request can land on a different
-- cold-started instance.

create table if not exists public.rate_limits (
  key text primary key,
  window_start bigint not null,
  count integer not null default 0
);

alter table public.rate_limits enable row level security;

-- Atomic hit-and-check: upsert increments (or resets, once the window has
-- elapsed) in a single statement, so concurrent requests can't race past
-- the limit.
create or replace function public.maroon_rate_limit_hit(
  p_key text,
  p_window_ms bigint,
  p_max integer
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now bigint := (floor(extract(epoch from clock_timestamp()) * 1000))::bigint;
  v_count integer;
begin
  insert into rate_limits (key, window_start, count)
  values (p_key, v_now, 1)
  on conflict (key) do update set
    window_start = case
      when rate_limits.window_start <= v_now - p_window_ms then v_now
      else rate_limits.window_start
    end,
    count = case
      when rate_limits.window_start <= v_now - p_window_ms then 1
      else rate_limits.count + 1
    end
  returning count into v_count;
  return v_count <= p_max;
end;
$$;

revoke all on table public.rate_limits from anon, authenticated;
revoke all on function public.maroon_rate_limit_hit(text, bigint, integer) from public, anon, authenticated;
grant all on table public.rate_limits to service_role;
grant execute on function public.maroon_rate_limit_hit(text, bigint, integer) to service_role;
