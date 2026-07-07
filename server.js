/*
 * Maroon Clothing - "Paint the Town Maroon" pop-up queue manager.
 *
 * Express server with pluggable persistence: local data/queue.json by default,
 * or Supabase Postgres when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set
 * (required for Vercel / multi-instance hosting).
 *
 * Notifications: multi-channel and fire-and-forget. Guests can get push
 * notifications (works even with the tab closed, on Android and on iOS once
 * added to the home screen) and emails at the "almost your turn" and "your
 * turn" moments. Every remote send has one retry and can never throw or
 * block a queue operation. Missing config simply disables a channel; the
 * queue itself never depends on any of them.
 */

require("./scripts/load-env").loadEnvFiles();

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const { createSmtpTransport, smtpCertHint, smtpAuthHint } = require("./scripts/smtp-transport");
const webpush = require("web-push");
const store = require("./scripts/store");

// ---------- config ----------
const PORT = process.env.PORT || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || "maroon2026";
const STORE_CAPACITY = parseInt(process.env.STORE_CAPACITY || "40", 10);
const GUESTS_PER_MINUTE = parseFloat(process.env.GUESTS_PER_MINUTE || "2");
const ALMOST_AHEAD = parseInt(process.env.ALMOST_AHEAD || "10", 10);

const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587", 10);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;
const EMAIL_ENABLED = !!(SMTP_HOST && SMTP_USER && SMTP_PASS);

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:hello@maroon.clothing";
const PUSH_ENABLED = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (PUSH_ENABLED) webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const sweepOpts = () => ({
  almostAhead: ALMOST_AHEAD,
  guestsPerMinute: GUESTS_PER_MINUTE,
  onNotify: (g) => notifyGuest(g, "headsUp"),
});

async function runSweep() {
  try {
    await store.sweepHeadsUp(sweepOpts());
  } catch (e) {
    console.error("sweepHeadsUp failed:", e.message);
  }
}

function cleanEmail(raw) {
  const e = String(raw || "").trim().toLowerCase().slice(0, 254);
  return /^\S+@\S+\.\S+$/.test(e) ? e : null;
}

function cleanPhone(raw) {
  const p = String(raw || "").trim().slice(0, 20);
  return /^\+?[\d\s-()]{8,20}$/.test(p) ? p : null;
}

// ---------- email ----------
let mailer = null;
if (EMAIL_ENABLED) {
  mailer = createSmtpTransport();
}

function emailHtml(guest, headline, body) {
  return `<div style="background:#f1ebeb;padding:24px 12px;font-family:Georgia,'Times New Roman',serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">
    <table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;width:100%;background:#ffffff;border:1px solid #e2d6d6;">
      <tr><td style="background:#6a1f2a;padding:22px 28px;text-align:center;">
        <span style="color:#ffffff;font-size:22px;letter-spacing:6px;text-transform:uppercase;">Maroon</span><br>
        <span style="color:#e8cdd2;font-size:11px;letter-spacing:3px;text-transform:uppercase;">Paint the Town Maroon</span>
      </td></tr>
      <tr><td style="padding:28px;">
        <h1 style="margin:0 0 12px;color:#6a1f2a;font-size:22px;font-weight:normal;">${headline}</h1>
        <p style="margin:0 0 18px;color:#333333;font-size:16px;line-height:1.5;">${body}</p>
        <p style="margin:0;color:#333333;font-size:16px;">Your queue number: <strong style="color:#6a1f2a;font-size:22px;">${guest.number}</strong></p>
      </td></tr>
      <tr><td style="padding:16px 28px;border-top:1px solid #eeeeee;text-align:center;color:#999999;font-size:12px;">Maroon Clothing, Mandarin Gallery #02-19. Wear the town.</td></tr>
    </table>
  </td></tr></table>
</div>`;
}

const NOTIFY_COPY = {
  linked: {
    headline: "You're locked in!",
    body: () =>
      "We'll give you a shout here when it's nearly your turn. Go roam the mall, we've got you!",
    text: (g) =>
      `You're number ${g.number} in the queue. We'll give you a shout here when it's nearly your turn. Go roam the mall, we've got you!`,
    subject: (g) => `You're in! Number ${g.number} at Paint the Town Maroon`,
  },
  headsUp: {
    headline: "You're almost up!",
    body: () => "Start making your way back to Maroon, about 5 minutes to go.",
    text: () =>
      "You're almost up! Start making your way back to Maroon, about 5 minutes to go.",
    subject: (g) => `Almost your turn! About 5 minutes to go, number ${g.number}`,
  },
  yourTurn: {
    headline: "It's your turn!",
    body: () => "Head to the Maroon entrance now, the team's ready for you.",
    text: () =>
      "It's your turn! Head to the Maroon entrance now, the team's ready for you.",
    subject: (g) => `It's your turn, number ${g.number}! Head to Maroon now`,
  },
};

function fireAndForget(label, send) {
  const attempt = () =>
    Promise.resolve()
      .then(send)
      .then((ok) => ok !== false)
      .catch((e) => {
        console.error(`Notify ${label} failed:`, e && e.message);
        return false;
      });
  attempt().then((ok) => {
    if (ok) return;
    setTimeout(() => {
      attempt().then((ok2) => {
        if (!ok2) console.error(`Notify ${label} gave up after one retry.`);
      });
    }, 3000);
  });
}

function emailPlainText(guest, headline, body) {
  return `${headline}\n\n${body}\n\nYour queue number: ${guest.number}`;
}

function notifyGuest(guest, kind) {
  const copy = NOTIFY_COPY[kind];
  if (!guest || !copy) return;
  const body = copy.body(guest);
  const text = copy.text(guest);

  if (PUSH_ENABLED && guest.pushSub) {
    const sub = guest.pushSub;
    const payload = JSON.stringify({ title: copy.headline, body, tag: "maroon-queue" });
    fireAndForget(`push ${kind} #${guest.number}`, async () => {
      try {
        await webpush.sendNotification(sub, payload);
        return true;
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) {
          guest.pushSub = null;
          await store.updateGuest(guest);
        }
        throw e;
      }
    });
  }

  if (mailer && guest.email) {
    const to = guest.email;
    fireAndForget(`email ${kind} #${guest.number}`, async () => {
      await mailer.sendMail({
        from: `"Maroon Clothing" <${SMTP_FROM}>`,
        to,
        subject: copy.subject(guest),
        text: emailPlainText(guest, copy.headline, body),
        html: emailHtml(guest, copy.headline, body),
      });
      return true;
    });
  }
}

// ---------- app ----------
const app = express();
if (process.env.TRUST_PROXY !== "0") app.set("trust proxy", 1);
app.use(express.json({ limit: "10kb" }));
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    return res.status(400).json({ error: "Invalid request body." });
  }
  next(err);
});
app.use(express.static(path.join(__dirname, "public")));
app.use((req, res, next) => {
  bootPromise.then(() => next()).catch(next);
});

process.on("uncaughtException", (e) => console.error("Uncaught:", e));
process.on("unhandledRejection", (e) => console.error("Unhandled rejection:", e));

const hits = new Map();
setInterval(() => hits.clear(), 60_000).unref();
function rateLimit(max) {
  return (req, res, next) => {
    const key = req.ip + req.path;
    const n = (hits.get(key) || 0) + 1;
    hits.set(key, n);
    if (n > max) return res.status(429).json({ error: "Too many requests, please slow down." });
    next();
  };
}

function asyncRoute(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

app.get("/api/health", asyncRoute(async (_req, res) => {
  const h = await store.getHealth();
  res.json({ ok: true, open: h.open, guests: h.guestCount, store: store.backend });
}));

app.get("/api/config", asyncRoute(async (_req, res) => {
  res.json({
    emailEnabled: EMAIL_ENABLED,
    vapidPublicKey: PUSH_ENABLED ? VAPID_PUBLIC_KEY : "",
    open: await store.isOpen(),
    capacity: STORE_CAPACITY,
    advanceMinutes: 5,
  });
}));

// Higher than the other guest endpoints: a mall Wi-Fi NAT can put dozens of
// guests behind one public IP during the opening rush, and they all hit this
// route once each (unlike status polling, which repeats per guest).
app.post("/api/join", rateLimit(40), asyncRoute(async (req, res) => {
  const name = String(req.body.name || "").trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: "Please enter your name." });
  const phone = cleanPhone(req.body.phone);
  if (!phone) {
    const msg = String(req.body.phone || "").trim()
      ? "That handphone number doesn't look right. Give it another go!"
      : "Drop your handphone number so we can reach you.";
    return res.status(400).json({ error: msg });
  }
  let email = null;
  if (EMAIL_ENABLED) {
    email = cleanEmail(req.body.email);
    if (!email) {
      const msg = String(req.body.email || "").trim()
        ? "That email doesn't look right. Give it another go!"
        : "Drop your email so we can reach you when it's time.";
      return res.status(400).json({ error: msg });
    }
  } else {
    email = cleanEmail(req.body.email);
  }
  try {
    const guest = await store.join({ name, phone, email });
    await runSweep();
    if (guest.email) notifyGuest(guest, "linked");
    res.json({ token: guest.token, number: guest.number });
  } catch (e) {
    if (e.code === "queue_closed") return res.status(403).json({ error: e.message });
    if (e.code === "queue_full") return res.status(503).json({ error: e.message });
    throw e;
  }
}));

app.get("/api/status/:token", rateLimit(60), asyncRoute(async (req, res) => {
  const guest = await store.findByToken(req.params.token);
  if (!guest) return res.status(404).json({ error: "Not found" });
  res.json(
    await store.getStatusPayload(guest, {
      guestsPerMinute: GUESTS_PER_MINUTE,
      almostAhead: ALMOST_AHEAD,
    })
  );
}));

app.post("/api/leave/:token", rateLimit(10), asyncRoute(async (req, res) => {
  const guest = await store.findByToken(req.params.token);
  if (guest && (guest.status === "waiting" || guest.status === "called")) {
    guest.status = "done";
    await store.updateGuest(guest);
    await runSweep();
  }
  res.json({ ok: true });
}));

app.post("/api/contact/:token", rateLimit(10), asyncRoute(async (req, res) => {
  const guest = await store.findByToken(req.params.token);
  if (!guest) return res.status(404).json({ error: "Not found" });
  const raw = String(req.body.email || "").trim();
  if (!raw) {
    if (EMAIL_ENABLED) {
      return res.status(400).json({ error: "We need your email to ping you when it's time." });
    }
    guest.email = null;
  } else {
    const email = cleanEmail(raw);
    if (!email) {
      return res.status(400).json({ error: "That email doesn't look right. Give it another go!" });
    }
    guest.email = email;
  }
  await store.updateGuest(guest);
  if (guest.email) notifyGuest(guest, "linked");
  res.json({ ok: true, email: guest.email });
}));

app.post("/api/push/subscribe/:token", rateLimit(10), asyncRoute(async (req, res) => {
  const guest = await store.findByToken(req.params.token);
  if (!guest) return res.status(404).json({ error: "Not found" });
  const sub = req.body.subscription;
  if (!sub || typeof sub.endpoint !== "string") {
    return res.status(400).json({ error: "Invalid push subscription" });
  }
  guest.pushSub = sub;
  await store.updateGuest(guest);
  res.json({ ok: true });
}));

app.post("/api/push/unsubscribe/:token", rateLimit(10), asyncRoute(async (req, res) => {
  const guest = await store.findByToken(req.params.token);
  if (guest) {
    guest.pushSub = null;
    await store.updateGuest(guest);
  }
  res.json({ ok: true });
}));

function requireAdmin(req, res, next) {
  if (req.headers["x-admin-pin"] === ADMIN_PIN) return next();
  res.status(401).json({ error: "Wrong PIN" });
}

app.get("/api/admin/state", requireAdmin, asyncRoute(async (_req, res) => {
  res.json(await store.getAdminState(STORE_CAPACITY));
}));

app.post("/api/admin/call-next", requireAdmin, asyncRoute(async (req, res) => {
  const n = Math.min(Math.max(parseInt(req.body.count || "1", 10), 1), 50);
  try {
    const { called, numbers } = await store.callNext(n, STORE_CAPACITY);
    for (const g of called) notifyGuest(g, "yourTurn");
    await runSweep();
    res.json({ called: numbers });
  } catch (e) {
    if (e.code === "store_full") return res.status(409).json({ error: e.message });
    throw e;
  }
}));

app.post("/api/admin/guest/:id", requireAdmin, asyncRoute(async (req, res) => {
  try {
    await store.guestAction(req.params.id, req.body.action);
    await runSweep();
    res.json({ ok: true });
  } catch (e) {
    if (e.code === "not_found") return res.status(404).json({ error: e.message });
    if (e.code === "bad_status" || e.code === "bad_action") {
      return res.status(400).json({ error: e.message });
    }
    throw e;
  }
}));

app.post("/api/admin/open", requireAdmin, asyncRoute(async (req, res) => {
  const open = await store.setOpen(!!req.body.open);
  await runSweep();
  res.json({ open });
}));

app.post("/api/admin/reset", requireAdmin, asyncRoute(async (_req, res) => {
  await store.reset();
  await runSweep();
  res.json({ ok: true });
}));

app.get("/admin", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "admin.html"))
);

app.use((err, _req, res, _next) => {
  console.error("Request error:", err);
  res.status(500).json({ error: "Internal server error" });
});

const bootPromise = boot();

async function boot() {
  await store.init();
  if (store.backend === "file" && process.env.VERCEL) {
    console.warn(
      "WARNING: Running on Vercel without Supabase. Queue state will NOT persist or sync across instances. " +
        "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."
    );
  }
  if (EMAIL_ENABLED) {
    console.log("Email notifications: enabled (SMTP)");
    mailer.verify().catch((e) => {
      console.error("SMTP verify failed (emails may not send):", e.message + smtpCertHint(e) + smtpAuthHint(e));
    });
  } else {
    console.log("SMTP not configured: email notifications disabled (set SMTP_HOST, SMTP_USER, SMTP_PASS).");
  }
  if (PUSH_ENABLED) console.log("Push notifications: enabled (VAPID)");
  else {
    console.log(
      "VAPID keys not set: push notifications disabled (run `npm run vapid-keys` and set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)."
    );
  }
  console.log(`Queue persistence: ${store.backend}`);
}

module.exports = app;

bootPromise.catch((e) => {
  console.error("Startup failed:", e.message || e);
});

if (!process.env.VERCEL) {
  bootPromise
    .then(() => {
      app.listen(PORT, () => {
        console.log(`Paint the Town Maroon queue running on http://localhost:${PORT}`);
      });
    })
    .catch((e) => {
      console.error("Startup failed:", e);
      process.exit(1);
    });
}
