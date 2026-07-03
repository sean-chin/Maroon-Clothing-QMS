# AGENTS.md

## Cursor Cloud specific instructions

Single-process Node.js/Express app (`server.js`) with no database, no build step, no test suite, no linter. Setup and run commands are in `README.md`; npm scripts are in `package.json` (`npm start`, `npm run check`).

Non-obvious notes:
- The app does **not** auto-load `.env`. Any env vars (`ADMIN_PIN`, `PORT`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `STORE_CAPACITY`, `GUESTS_PER_MINUTE`, `ALMOST_AHEAD`, `SMTP_*`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`) must be exported in the shell before `npm start`. With no vars set, the app runs fully with defaults (admin PIN `maroon2026`, port `3000`); Telegram, email, and push notifications are simply disabled (in-tab browser alerts still work while a tab is open).
- There is **no hot reload/watch**, so restart `node server.js` after code changes.
- State is held in memory and snapshotted to `data/queue.json` (gitignored, created at runtime). This file persists the queue across restarts, so delete it or hit `POST /api/admin/reset` (header `x-admin-pin: <PIN>`) for a clean slate. The app is single-instance only (in-memory state is not multi-process safe).
- The manager dashboard is at `/admin`; the guest page is at `/`. Health check: `GET /api/health`.
