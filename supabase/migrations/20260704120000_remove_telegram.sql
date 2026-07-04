-- Telegram notifications removed: drop the columns and stop returning them
-- from maroon_join_guest. Reset offset tracking is gone too.

alter table public.guests drop column if exists tg_chat;
alter table public.queue_settings drop column if exists tg_offset;

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
