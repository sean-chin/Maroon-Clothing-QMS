-- Add compulsory handphone number collection for guests joining the queue.

alter table public.guests add column if not exists phone text;
update public.guests set phone = '' where phone is null;
alter table public.guests alter column phone set default '';
alter table public.guests alter column phone set not null;

-- Recreate maroon_join_guest to accept and persist the guest's phone number.
drop function if exists public.maroon_join_guest(uuid, text, text, text);

create or replace function public.maroon_join_guest(
  p_id uuid,
  p_token text,
  p_name text,
  p_phone text,
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
  insert into guests (id, token, number, name, phone, status, joined_at, email, heads_up_sent)
  values (
    p_id,
    p_token,
    v_seq,
    p_name,
    p_phone,
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
    'phone', v_row.phone,
    'status', v_row.status,
    'joinedAt', v_row.joined_at,
    'calledAt', v_row.called_at,
    'tgChat', v_row.tg_chat,
    'email', v_row.email,
    'pushSub', v_row.push_sub,
    'headsUpSent', v_row.heads_up_sent
  );
end;
$$;

revoke all on function public.maroon_join_guest(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.maroon_join_guest(uuid, text, text, text, text) to service_role;
