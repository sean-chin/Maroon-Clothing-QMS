-- Allow calling any number of waiting guests at once (no store-capacity gate on call-next).
drop function if exists public.maroon_call_next(integer, integer);

create or replace function public.maroon_call_next(
  p_count integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_waiting integer;
  v_to_call integer;
  v_ids uuid[];
  v_numbers integer[];
begin
  select count(*)::integer into v_waiting from guests where status = 'waiting';
  if v_waiting <= 0 then
    raise exception 'queue_empty';
  end if;
  v_to_call := least(greatest(p_count, 1), v_waiting);

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

revoke all on function public.maroon_call_next(integer) from public, anon, authenticated;
grant execute on function public.maroon_call_next(integer) to service_role;
