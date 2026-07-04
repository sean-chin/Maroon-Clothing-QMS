-- A misclicked "Reset entire queue" used to be unrecoverable (hard delete,
-- no backup). Snapshot every guest row into an archive table, tagged with
-- when the reset happened, before wiping the live table.

create table if not exists public.guests_archive (
  archived_at bigint not null,
  id uuid not null,
  token text not null,
  number integer not null,
  name text not null,
  status text not null,
  joined_at bigint not null,
  called_at bigint,
  email text,
  push_sub jsonb,
  heads_up_sent boolean not null default false
);

create index if not exists guests_archive_archived_at_idx on public.guests_archive (archived_at);

create or replace function public.maroon_reset_queue()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now bigint := (floor(extract(epoch from clock_timestamp()) * 1000))::bigint;
begin
  insert into guests_archive (
    archived_at, id, token, number, name, status, joined_at, called_at, email, push_sub, heads_up_sent
  )
  select v_now, id, token, number, name, status, joined_at, called_at, email, push_sub, heads_up_sent
  from guests;
  delete from guests;
  update queue_settings set seq = 0, open = true where id = 1;
end;
$$;

revoke all on table public.guests_archive from anon, authenticated;
grant all on table public.guests_archive to service_role;
