const useSupabase = !!(
  process.env.SUPABASE_URL &&
  (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)
);

module.exports = useSupabase ? require("./supabase") : require("./file");
