# Paint the Town Maroon - Queue Manager

Digital queue for the Maroon Clothing pop-up (11-12 July, 1-8pm). Guests join on their phone, roam the mall, and get a Telegram + browser notification about 5 minutes before their turn. The queue manager runs everything from a simple dashboard.

## How it works

- **Guest page (`/`)**: guest enters their name, gets a queue number, sees how many guests are ahead and a rough wait estimate. Page auto-refreshes every 5s. They can tap "Get notified on Telegram" to link the bot and then close the page entirely.
- **Manager dashboard (`/admin`)**: PIN-protected. Shows waiting / called / in-store counts. When guests leave the store, the manager clicks **Call & notify** for the next N guests; those guests instantly get the "head to the store now, ~5 min" message. Manager then marks them **Entered**, **Left store**, **No-show**, or **Re-queue**.

Statuses flow: `waiting -> called -> in store -> done` (or `no-show`).

## Stability

- Single Node process, no database to fail. State is snapshotted atomically to `data/queue.json` on every change, so a crash or restart restores the full queue.
- Per-IP rate limiting on guest endpoints; global error handlers so one bad request never takes the server down. 300 concurrent guests polling every 5s is ~60 req/s, trivial load.
- Telegram sends are fire-and-forget with a retry, so a Telegram outage never blocks the queue (guests still get the on-page alert).

## Setup

```
npm install
npm start          # http://localhost:3000  (guest)  /admin (manager)
```

### Telegram notifications

1. Message **@BotFather** on Telegram, `/newbot`, pick a name like "Maroon Queue".
2. Copy the token and username into your environment (see `.env.example`):
   ```powershell
   $env:TELEGRAM_BOT_TOKEN="123456:ABC..."
   $env:TELEGRAM_BOT_USERNAME="MaroonQueueBot"
   $env:ADMIN_PIN="pick-a-pin"
   npm start
   ```
Without a token the app still works fully, using browser notifications only.

### Going live for the event

Guests need a public URL (QR code at the store entrance works great). Easiest options:

- Deploy to a small VM / Render / Railway / Fly.io (any Node host with a persistent disk for `data/`).
- Or run locally and expose with a tunnel (e.g. `cloudflared tunnel`) for a zero-deploy setup.

Note: it's a single-process design (in-memory state), so run exactly one instance; don't use serverless/multi-instance hosting.

## Branding

`public/logo.svg` is a placeholder. Drop the real logo from the branding Drive folder into `public/` and update the `<img src>` in `index.html` and `admin.html` (or just save it over `logo.svg`). Colours live in `public/style.css` under `:root`; the site uses Times New Roman (condensed) and a predominantly maroon palette.
