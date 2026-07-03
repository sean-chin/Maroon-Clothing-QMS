# Paint the Town Maroon - Queue Manager

Digital queue for the Maroon Clothing pop-up (11-12 July, 1-8pm). Guests join on their phone, roam the mall, and get pinged on up to three channels (browser alerts, Telegram, email) when it's almost their turn and again when it's their turn. The queue manager runs everything from a simple dashboard.

## How it works

- **Guest page (`/`)**: guest enters their name (plus an optional email), gets a queue number, sees how many guests are ahead and a rough wait estimate. Page auto-refreshes every few seconds. A "Never miss your call" card lets them switch on browser alerts, link the Telegram bot, or add an email, then go roam the mall.
- **Manager dashboard (`/admin`)**: PIN-protected. Shows waiting / called / in-store counts. When guests leave the store, the manager calls the next N guests; those guests instantly get the "it's your turn" ping on every channel they linked. Manager then marks them **Entered**, **Left store**, **No-show**, or **Re-queue**. Small TG / @ chips in the queue table show who gets pinged remotely and who is browser-only.

Statuses flow: `waiting -> called -> in store -> done` (or `no-show`).

## Notifications

Guests get two nudges: a **heads-up** when roughly 5 minutes remain (when `ALMOST_AHEAD` or fewer guests are ahead of them, tracked server-side so it fires exactly once, even across restarts) and a **your turn** ping the moment the manager calls them in. Both fan out to every channel the guest linked:

- **Browser alerts** (always available): the guest page fires a system notification, a vibration and a short chime when the phase flips to "almost" or "your turn". The tab title also flips to "YOUR TURN | Maroon". Works with zero server config; the guest just taps "Turn on" on the status page.
- **Telegram** (optional): guests tap a deep link to the bot, which links their chat via `/start <token>`. Enabled by setting `TELEGRAM_BOT_TOKEN` and `TELEGRAM_BOT_USERNAME`.
- **Email** (optional): guests add an email when joining or later from the status page. Sends a plain-text plus simple branded HTML message over SMTP. Enabled by setting the `SMTP_*` variables.

Every remote send is fire-and-forget with one retry after ~3 seconds: a Telegram or SMTP outage is logged and never blocks or delays the queue. A channel with missing config simply stays off; the queue itself never depends on any of them.

## Stability

- Single Node process, no database to fail. State is snapshotted atomically to `data/queue.json` on every change, so a crash or restart restores the full queue.
- Per-IP rate limiting on guest endpoints; global error handlers so one bad request never takes the server down. 300 concurrent guests polling every 5s is ~60 req/s, trivial load.
- Telegram and email sends are fire-and-forget with a retry, so an outage on either never blocks the queue (guests still get the on-page and browser alerts).

## Setup

Requires [Node.js](https://nodejs.org/) 18+.

```
npm install
npm start
```

Then open:

- **Guest page** — http://localhost:3000
- **Manager dashboard** — http://localhost:3000/admin

The dashboard asks for a **Manager PIN**. It defaults to `maroon2026` (set your own with `ADMIN_PIN`, see below). The PIN can contain **letters and numbers**, and the login screen has a "Show" button so you can double-check it on your phone.

### Configuration (optional)

All settings are environment variables; the app runs fine with the defaults if you set nothing. It does **not** auto-load a `.env` file, so export the variables in your shell before `npm start`. See `.env.example` for the full list (`ADMIN_PIN`, `PORT`, `STORE_CAPACITY`, `GUESTS_PER_MINUTE`, `ALMOST_AHEAD`, Telegram tokens, SMTP settings).

**macOS / Linux (bash/zsh):**
```bash
ADMIN_PIN="pick-a-pin" PORT=3000 npm start
```

**Windows (PowerShell):**
```powershell
$env:ADMIN_PIN="pick-a-pin"; $env:PORT="3000"; npm start
```

### Telegram notifications

1. Message **@BotFather** on Telegram, `/newbot`, pick a name like "Maroon Queue".
2. Copy the token and username into your environment (see `.env.example`), e.g. on macOS / Linux:
   ```bash
   TELEGRAM_BOT_TOKEN="123456:ABC..." TELEGRAM_BOT_USERNAME="MaroonQueueBot" npm start
   ```
   …or on Windows PowerShell:
   ```powershell
   $env:TELEGRAM_BOT_TOKEN="123456:ABC..."; $env:TELEGRAM_BOT_USERNAME="MaroonQueueBot"; npm start
   ```
Without a token the app still works fully, using browser (and, if configured, email) notifications only.

### Email notifications (SMTP)

Set `SMTP_HOST`, `SMTP_USER` and `SMTP_PASS` (all three are required for email to switch on; without them the channel is silently disabled, exactly like Telegram without a token). `SMTP_PORT` defaults to `587` (STARTTLS; use `465` for implicit TLS) and `SMTP_FROM` defaults to `SMTP_USER`.

Gmail example: turn on 2-step verification for the Google account, create an **app password** at https://myaccount.google.com/apppasswords, then:

```bash
SMTP_HOST="smtp.gmail.com" SMTP_PORT=587 \
SMTP_USER="you@gmail.com" SMTP_PASS="abcd efgh ijkl mnop" \
SMTP_FROM="you@gmail.com" npm start
```

…or on Windows PowerShell:

```powershell
$env:SMTP_HOST="smtp.gmail.com"; $env:SMTP_USER="you@gmail.com"; $env:SMTP_PASS="abcd efgh ijkl mnop"; npm start
```

Emails go out as plain text plus a simple maroon-branded HTML version that renders fine in Gmail. Any regular SMTP provider (Mailgun, Postmark, SES, your own box) works the same way.

### Going live for the event

Guests need a public URL (QR code at the store entrance works great). Easiest options:

- Deploy to a small VM / Render / Railway / Fly.io (any Node host with a persistent disk for `data/`).
- Or run locally and expose with a tunnel (e.g. `cloudflared tunnel`) for a zero-deploy setup.

Note: it's a single-process design (in-memory state), so run exactly one instance; don't use serverless/multi-instance hosting.

## Branding

`public/logo.svg` is a placeholder. Drop the real logo from the branding Drive folder into `public/` and update the `<img src>` in `index.html` and `admin.html` (or just save it over `logo.svg`). Colours live in `public/style.css` under `:root`; the site uses Times New Roman (condensed) and a predominantly maroon palette.
