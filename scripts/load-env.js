/**
 * Load .env then .env.local from the project root. Does not overwrite
 * variables already set in the environment (so deploy configs still win).
 */
const fs = require("fs");
const path = require("path");

function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const eq = trimmed.indexOf("=");
  if (eq < 1) return null;
  const key = trimmed.slice(0, eq).trim();
  let val = trimmed.slice(eq + 1).trim();
  if (
    (val.startsWith('"') && val.endsWith('"')) ||
    (val.startsWith("'") && val.endsWith("'"))
  ) {
    val = val.slice(1, -1);
  }
  return { key, val };
}

// `vercel env pull` writes these into .env.local as a snapshot, but they're
// only meaningful when injected live by Vercel's own runtime. Loading them
// from a stale file locally makes the app think it's running on Vercel
// (server.js checks process.env.VERCEL to decide whether to open a port).
const VERCEL_RUNTIME_PREFIX = /^VERCEL/;

function loadEnvFiles(root = path.join(__dirname, "..")) {
  for (const name of [".env", ".env.local"]) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const parsed = parseLine(line);
      if (!parsed) continue;
      if (VERCEL_RUNTIME_PREFIX.test(parsed.key)) continue;
      if (process.env[parsed.key] === undefined) {
        process.env[parsed.key] = parsed.val;
      }
    }
  }
}

module.exports = { loadEnvFiles };
