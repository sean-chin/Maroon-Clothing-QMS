# AGENTS.md

## Cursor Cloud specific instructions

Single-process Node.js/Express app (`server.js`) with no database, no build step, no test suite, no linter. Setup and run commands are in `README.md`; npm scripts are in `package.json` (`npm start`, `npm run check`).

Non-obvious notes:
- The app auto-loads `.env` and `.env.local` from the project root on startup (later files do not override vars already set in the shell). Env vars include `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_PIN`, `PORT`, `TELEGRAM_*`, `STORE_CAPACITY`, `GUESTS_PER_MINUTE`, `ALMOST_AHEAD`, `SMTP_*`, `VAPID_*`. With no vars set, the app runs fully with defaults (admin PIN `maroon2026`, port `3000`); Telegram, email, and push notifications are simply disabled (in-tab browser alerts still work while a tab is open).
- There is **no hot reload/watch**, so restart `node server.js` after code changes.
- Without Supabase env vars, state is in-memory + `data/queue.json` (gitignored). With `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`, state is in Postgres (required for Vercel). Reset via `POST /api/admin/reset` (header `x-admin-pin: <PIN>`) or delete `data/queue.json` locally.
- The manager dashboard is at `/admin`; the guest page is at `/`. Health check: `GET /api/health`.
