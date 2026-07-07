-- Supabase's safeupdate guard (preloaded on the authenticator role used by
-- PostgREST/RPC) blocks any DELETE/UPDATE without a WHERE clause, even ones
-- issued inside a SECURITY DEFINER function. `delete from guests;` was
-- tripping this, making POST /api/admin/reset fail with:
--   "DELETE requires a WHERE clause" (SQLSTATE 21000)
create or replace function public.maroon_reset_queue()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from guests where true;
  update queue_settings set seq = 0, open = true where id = 1;
end;
$$;
