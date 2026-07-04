#!/usr/bin/env node
/**
 * Quick check that Supabase queue schema is reachable with service role credentials.
 * Usage: node scripts/verify-supabase.js
 */
require("../scripts/load-env").loadEnvFiles();

const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const url = process.env.SUPABASE_URL || "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

async function main() {
  if (!url || !key) {
    console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env or .env.local");
    process.exit(1);
  }
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: settings, error: settingsErr } = await sb
    .from("queue_settings")
    .select("id, seq, open")
    .eq("id", 1)
    .maybeSingle();
  if (settingsErr) throw settingsErr;
  console.log("queue_settings:", settings);

  const testId = crypto.randomUUID();
  const testToken = "verify-" + Date.now();
  const { data: guest, error: joinErr } = await sb.rpc("maroon_join_guest", {
    p_id: testId,
    p_token: testToken,
    p_name: "Verify Test",
    p_email: null,
  });
  if (joinErr) throw joinErr;
  console.log("maroon_join_guest ok, number:", guest.number);

  await sb.from("guests").delete().eq("id", testId);
  console.log("Cleanup ok. Supabase queue store is ready.");
}

main().catch((e) => {
  console.error("Verify failed:", e.message || e);
  process.exit(1);
});
