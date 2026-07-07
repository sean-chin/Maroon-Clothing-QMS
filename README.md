# Paint the Town Maroon - Queue Manager

Digital queue for the Maroon Clothing pop-up (11 & 12 July, 1pm to 8pm). Guests join on their phone, roam the mall, and get pinged on up to two channels (push notifications, email) when it's almost their turn and again when it's their turn. The queue manager runs everything from a simple dashboard.

## How it works

- **Guest page (`/`)**: guest enters their name and handphone number (required, plus an optional email), gets a queue number, sees how many guests are ahead and a rough wait estimate. Page auto-refreshes every few seconds. A "Never miss your call" card lets them switch on push notifications or add an email, then go roam the mall.
- **Manager dashboard (`/admin`)**: PIN-protected. Shows waiting / called / in-store counts, plus each guest's name and handphone number. When guests leave the store, the manager calls the next N guests; those guests instantly get the "it's your turn" ping on every channel they linked. Manager then marks them **Entered**, **Left store**, **No-show**, or **Re-queue**. Small PUSH / TG / @ chips in the queue table show who gets pinged remotely.

Statuses flow: `waiting -> called -> in store -> done` (or `no-show`).

## Notifications

Guests get two nudges: a **heads-up** when roughly 5 minutes remain (when `ALMOST_AHEAD` or fewer guests are ahead of them, tracked server-side so it fires exactly once, even across restarts) and a **your turn** ping the moment the manager calls them in. Both fan out to every channel the guest linked:

- **Push notifications** (recommended, works with the tab closed): the guest taps "Turn on" once and their phone gets a real system notification, a vibration and a sound, even with the browser closed and the screen locked. On Android this works straight away. On iOS it needs the page added to the home screen first (iOS 16.4+); the guest page shows that hint automatically on iPhone. Needs `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` set (see below); without them the app falls back to a plain in-tab alert that only fires while the tab is open.
- **Email** (optional): guests add an email when joining or later from the status page. Sends a plain-text plus simple branded HTML message over SMTP. Enabled by setting the `SMTP_*` variables.

Every remote send is fire-and-forget with one retry after ~3 seconds: an SMTP or push outage is logged and never blocks or delays the queue. A channel with missing config simply stays off; the queue itself never depends on any of them.

For the most reliable setup, turn on both: push covers guests who close the tab, email is the backup in case a guest's browser blocks push (some in-app browsers do).

## The Maroon Ticket

Every guest with a spot gets a shareable, story-sized ticket rendered right on their status page: their queue number, their name, the oval badge and the event details in full Maroon branding. They can save it as a PNG or share it straight to their story.

**Golden ticket rule (staff, read this):** every queue number divisible by 25 (25, 50, 75, ...) gets a gold ticket instead, and the copy tells the guest to show it at the door for a little surprise from Maroon. Those rows are marked with a **Gold** chip in the dashboard queue table, so expect a golden ticket to appear at the entrance and have the surprise ready.

## Stability

- Single Node process, no database to fail. State is snapshotted atomically to `data/queue.json` on every change, so a crash or restart restores the full queue.
- Per-IP rate limiting on guest endpoints; global error handlers so one bad request never takes the server down. 300 concurrent guests polling every 5s is ~60 req/s, trivial load.
- Push and email sends are both fire-and-forget with a retry, so an outage on either never blocks the queue (guests still get the on-page status).

## Setup

Requires [Node.js](https://nodejs.org/) 18+.

```
npm install
npm start
```

Then open:

- **Guest page**: http://localhost:3000
- **Manager dashboard**: http://localhost:3000/admin

The dashboard asks for a **Manager PIN**. It defaults to `maroon2026` (set your own with `ADMIN_PIN`, see below). The PIN can contain **letters and numbers**, and the login screen has a "Show" button so you can double-check it on your phone.

### Configuration (optional)

All settings are environment variables, and the app runs fine with the defaults if you set nothing. The app auto-loads `.env` then `.env.local` from the project root on startup (a variable already set in your shell always wins). See `.env.example` for the full list (`ADMIN_PIN`, `PORT`, `STORE_CAPACITY`, `GUESTS_PER_MINUTE`, `ALMOST_AHEAD`, SMTP settings, VAPID keys).

**macOS / Linux (bash/zsh):**
```bash
ADMIN_PIN="pick-a-pin" PORT=3000 npm start
```

**Windows (PowerShell):**
```powershell
$env:ADMIN_PIN="pick-a-pin"; $env:PORT="3000"; npm start
```

### Push notifications (recommended)

This is the channel that actually reaches a guest roaming the mall with the phone locked and the tab closed, so it's worth setting up first.

1. Generate a keypair once (never commit it):
   ```bash
   npm run vapid-keys
   ```
   This prints a public and private key.
2. Set them in your environment, e.g. on macOS / Linux:
   ```bash
   VAPID_PUBLIC_KEY="BN..." VAPID_PRIVATE_KEY="xy..." npm start
   ```
   …or on Windows PowerShell:
   ```powershell
   $env:VAPID_PUBLIC_KEY="BN..."; $env:VAPID_PRIVATE_KEY="xy..."; npm start
   ```
3. Reuse the same keypair across restarts and redeploys. If you swap it out, every guest who already turned notifications on has to tap "Turn on" again.

**On the guest's phone:**
- **Android (Chrome)**: tapping "Turn on" is enough. Push works even after the tab is closed.
- **iPhone (Safari, iOS 16.4+)**: Safari only allows push for sites added to the home screen. The guest page detects this and shows a hint: tap Share, then "Add to Home Screen", open Maroon from the new icon, then tap "Turn on" from there. Older iOS versions can't receive push at all, browser alerts included, so lean on email for those guests.

Without `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` set, the "Browser alerts" toggle still works as a plain in-tab notification (sound, vibration, system alert) but only while the tab stays open and in view, exactly like before this channel existed.

### Email notifications (SMTP)

Set `SMTP_HOST`, `SMTP_USER` and `SMTP_PASS` (all three are required for email to switch on; without them the channel is silently disabled). `SMTP_PORT` defaults to `587` (STARTTLS; use `465` for implicit TLS) and `SMTP_FROM` defaults to `SMTP_USER`.

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

To check the setup before opening the queue, send yourself a test email with the same env vars set:

```bash
SMTP_HOST="smtp.gmail.com" SMTP_USER="you@gmail.com" SMTP_PASS="abcd efgh ijkl mnop" \
npm run test-email -- you@gmail.com
```

If it lands (check spam once), the app is good to go.

### Going live for the event

Guests need a public URL (QR code at the store entrance works great).

**Vercel:** set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in project env (service role only — never in the browser). Run `supabase/migrations/*.sql` once in the Supabase SQL editor, then redeploy.

**VM / Railway / Render / Fly.io:** works with or without Supabase. Without it, run exactly one instance with persistent `data/`.

**Quick tunnel:** run locally and expose via Cloudflare Tunnel.

Without Supabase on multi-instance hosts, queue state will not stay consistent. See `.env.example`.

## Branding

`public/logo.svg` is a placeholder. Drop the real logo from the branding Drive folder into `public/` and update the `<img src>` in `index.html` and `admin.html` (or just save it over `logo.svg`). Colours live in `public/style.css` under `:root`; the site uses Times New Roman (condensed) and a predominantly maroon palette.
