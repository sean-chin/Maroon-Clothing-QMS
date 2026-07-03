/*
 * Maroon Clothing - "Paint the Town Maroon" pop-up queue manager.
 *
 * Single-process Express server. All state lives in memory and is
 * snapshotted atomically to data/queue.json on every change, so a crash
 * or restart never loses the queue. Guests poll their status; the queue
 * manager drives the queue from /admin.
 *
 * Notifications: multi-channel and fire-and-forget. Guests can get push
 * notifications (works even with the tab closed, on Android and on iOS once
 * added to the home screen), Telegram messages, and emails at the "almost
 * your turn" and "your turn" moments. Every remote send has one retry and
 * can never throw or block a queue operation. Missing config simply
 * disables a channel; the queue itself never depends on any of them.
 */

require("./scripts/load-env").loadEnvFiles();

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const { createSmtpTransport, smtpCertHint, smtpAuthHint } = require("./scripts/smtp-transport");
const webpush = require("web-push");

// ---------- config ----------
const PORT = process.env.PORT || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || "maroon2026";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || ""; // e.g. MaroonQueueBot (no @)
const STORE_CAPACITY = parseInt(process.env.STORE_CAPACITY || "40", 10);
// Rough throughput used only for the "estimated wait" hint shown to guests.
const GUESTS_PER_MINUTE = parseFloat(process.env.GUESTS_PER_MINUTE || "2");
// ~5-minute advance warning when this many guests (or fewer) are ahead.
const ALMOST_AHEAD = parseInt(process.env.ALMOST_AHEAD || "10", 10);

// SMTP config for email notifications. Like Telegram without a token,
// missing host or credentials just means the channel stays off.
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587", 10);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;
const EMAIL_ENABLED = !!(SMTP_HOST && SMTP_USER && SMTP_PASS);

// Web Push config for real device notifications, working even with the tab
// closed. Generate a keypair once with `npm run vapid-keys`. Like the other
// channels, missing keys just means push stays off.
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:hello@maroon.clothing";
const PUSH_ENABLED = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (PUSH_ENABLED) webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "queue.json");

// ---------- state + persistence ----------
let state = {
  seq: 0, // last issued queue number
  guests: [], // {id, token, number, name, status, joinedAt, calledAt, tgChat, email, pushSub, headsUpSent}
  open: true,
};
// statuses: waiting -> called -> inStore -> done | noShow

try {
  if (fs.existsSync(DATA_FILE)) {
    state = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    console.log(`Restored queue: ${state.guests.length} guests, seq ${state.seq}`);
  }
} catch (e) {
  console.error("Could not restore snapshot, starting fresh:", e.message);
}

let saveTimer = null;
function save() {
  // Debounced atomic snapshot: write temp file then rename.
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = DATA_FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, DATA_FILE);
    } catch (e) {
      console.error("Snapshot failed:", e.message);
    }
  }, 200);
}

// ---------- helpers ----------
const byToken = (t) => state.guests.find((g) => g.token === t);
const byId = (id) => state.guests.find((g) => g.id === id);
const waiting = () => state.guests.filter((g) => g.status === "waiting");
const called = () => state.guests.filter((g) => g.status === "called");
const inStore = () => state.guests.filter((g) => g.status === "inStore");

function positionInfo(guest) {
  const ahead =
    waiting().filter((g) => g.number < guest.number).length + called().length;
  const estMinutes = Math.max(1, Math.round(ahead / GUESTS_PER_MINUTE));
  const aheadMax = Math.max(ALMOST_AHEAD, waiting().length + called().length);
  return { ahead, estMinutes, aheadMax };
}

function guestPhase(guest) {
  if (guest.status === "inStore") return "inStore";
  if (guest.status === "done" || guest.status === "noShow") return "done";
  if (guest.status === "called") return "yourTurn";
  const { ahead } = positionInfo(guest);
  if (ahead <= ALMOST_AHEAD) return "almost";
  return "waiting";
}

// Loose email normaliser: trim, lowercase, cap length, sanity-check shape.
// Returns the cleaned address or null when the input isn't usable.
function cleanEmail(raw) {
  const e = String(raw || "").trim().toLowerCase().slice(0, 254);
  return /^\S+@\S+\.\S+$/.test(e) ? e : null;
}

function slotsAvailable() {
  return Math.max(0, STORE_CAPACITY - inStore().length);
}

function suggestedCallCount() {
  const slots = slotsAvailable();
  const roomForCalled = Math.max(0, slots - called().length);
  return Math.min(waiting().length, roomForCalled);
}

// ---------- telegram ----------
async function tgApi(method, body) {
  if (!BOT_TOKEN) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return await res.json();
  } catch (e) {
    console.error(`Telegram ${method} failed:`, e.message);
    return null;
  }
}

// ---------- email ----------
let mailer = null;
if (EMAIL_ENABLED) {
  mailer = createSmtpTransport();
}

// Simple branded HTML that renders fine in Gmail: maroon header, white body.
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

// ---------- notifications ----------
// Brand-voice copy for each notification moment.
// headline + body go to email HTML and push (no repeated opener in the body).
// text is the full standalone message for Telegram.
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

// Run a channel send in the background with one retry after ~3s.
// Never throws, never blocks the caller; failures only get logged.
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

// Central dispatcher: fans a notification out to every channel the guest
// linked. kind is "linked", "headsUp" or "yourTurn".
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
        // Subscription is gone (permission revoked, browser data cleared, etc).
        if (e.statusCode === 404 || e.statusCode === 410) {
          guest.pushSub = null;
          save();
        }
        throw e;
      }
    });
  }

  if (BOT_TOKEN && guest.tgChat) {
    const chatId = guest.tgChat;
    fireAndForget(`telegram ${kind} #${guest.number}`, async () => {
      const r = await tgApi("sendMessage", { chat_id: chatId, text });
      return !!(r && r.ok);
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

// Server-side 5-minute heads-up. Runs after every state mutation: any
// waiting guest who has crossed into the "almost" zone gets warned once.
// headsUpSent keeps it idempotent; requeue clears it so they can be
// warned again on their second run through the queue.
function sweepHeadsUp() {
  let changed = false;
  for (const g of waiting()) {
    if (g.headsUpSent) continue;
    if (positionInfo(g).ahead <= ALMOST_AHEAD) {
      g.headsUpSent = true;
      changed = true;
      notifyGuest(g, "headsUp");
    }
  }
  if (changed) save();
}

// Long-poll getUpdates to link guests' Telegram chats via /start <token>.
let tgOffset = 0;
async function tgPollLoop() {
  if (!BOT_TOKEN) return;
  for (;;) {
    const r = await tgApi("getUpdates", { offset: tgOffset, timeout: 25 });
    if (r && r.ok) {
      for (const u of r.result) {
        tgOffset = u.update_id + 1;
        const msg = u.message;
        if (!msg || !msg.text) continue;
        const m = msg.text.match(/^\/start\s+(\S+)/);
        if (m) {
          const guest = byToken(m[1]);
          if (guest) {
            guest.tgChat = msg.chat.id;
            save();
            notifyGuest(guest, "linked");
          } else {
            tgApi("sendMessage", {
              chat_id: msg.chat.id,
              text: "Hmm, that queue link doesn't look valid. Please rejoin the queue from the website.",
            });
          }
        }
      }
    } else {
      await new Promise((res) => setTimeout(res, 5000)); // back off on errors
    }
  }
}
tgPollLoop().catch((e) => console.error("Telegram poll loop died:", e.message));

// ---------- app ----------
const app = express();
app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public")));

// Keep the process alive no matter what a request throws.
process.on("uncaughtException", (e) => console.error("Uncaught:", e));
process.on("unhandledRejection", (e) => console.error("Unhandled rejection:", e));

// Simple per-IP rate limit (protects the join endpoint from hammering).
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

// ----- guest API -----
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, open: state.open, guests: state.guests.length });
});

app.get("/api/config", (_req, res) => {
  res.json({
    botUsername: BOT_USERNAME,
    emailEnabled: EMAIL_ENABLED,
    vapidPublicKey: PUSH_ENABLED ? VAPID_PUBLIC_KEY : "",
    open: state.open,
    capacity: STORE_CAPACITY,
    advanceMinutes: 5,
  });
});

app.post("/api/join", rateLimit(10), (req, res) => {
  if (!state.open) return res.status(403).json({ error: "The queue is currently closed." });
  const name = String(req.body.name || "").trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: "Please enter your name." });
  if (state.guests.length >= 5000) return res.status(503).json({ error: "Queue is full." });
  state.seq += 1;
  const guest = {
    id: crypto.randomUUID(),
    token: crypto.randomBytes(12).toString("hex"),
    number: state.seq,
    name,
    status: "waiting",
    joinedAt: Date.now(),
    calledAt: null,
    tgChat: null,
    // Optional email; an invalid address never blocks the join, we just drop it.
    email: cleanEmail(req.body.email),
    pushSub: null,
    headsUpSent: false,
  };
  state.guests.push(guest);
  save();
  sweepHeadsUp();
  if (guest.email) notifyGuest(guest, "linked");
  res.json({ token: guest.token, number: guest.number });
});

app.get("/api/status/:token", rateLimit(60), (req, res) => {
  const guest = byToken(req.params.token);
  if (!guest) return res.status(404).json({ error: "Not found" });
  const { ahead, estMinutes, aheadMax } = positionInfo(guest);
  const phase = guestPhase(guest);
  res.json({
    number: guest.number,
    name: guest.name,
    status: guest.status,
    phase,
    ahead: phase === "waiting" || phase === "almost" ? ahead : 0,
    estMinutes: phase === "waiting" || phase === "almost" ? estMinutes : 0,
    aheadMax,
    advanceMinutes: 5,
    channels: { telegram: !!guest.tgChat, email: !!guest.email, push: !!guest.pushSub },
  });
});

app.post("/api/leave/:token", rateLimit(10), (req, res) => {
  const guest = byToken(req.params.token);
  if (guest && (guest.status === "waiting" || guest.status === "called")) {
    guest.status = "done";
    save();
    sweepHeadsUp();
  }
  res.json({ ok: true });
});

// Add, change or clear the guest's email after joining. Empty string clears.
app.post("/api/contact/:token", rateLimit(10), (req, res) => {
  const guest = byToken(req.params.token);
  if (!guest) return res.status(404).json({ error: "Not found" });
  const raw = String(req.body.email || "").trim();
  if (!raw) {
    guest.email = null;
  } else {
    const email = cleanEmail(raw);
    if (!email) {
      return res.status(400).json({ error: "That email doesn't look right. Give it another go!" });
    }
    guest.email = email;
  }
  save();
  if (guest.email) notifyGuest(guest, "linked");
  res.json({ ok: true, email: guest.email });
});

// Register a browser push subscription for this guest. Works even after the
// tab is closed, on Android straight away and on iOS once the page has been
// added to the home screen.
app.post("/api/push/subscribe/:token", rateLimit(10), (req, res) => {
  const guest = byToken(req.params.token);
  if (!guest) return res.status(404).json({ error: "Not found" });
  const sub = req.body.subscription;
  if (!sub || typeof sub.endpoint !== "string") {
    return res.status(400).json({ error: "Invalid push subscription" });
  }
  guest.pushSub = sub;
  save();
  res.json({ ok: true });
});

app.post("/api/push/unsubscribe/:token", rateLimit(10), (req, res) => {
  const guest = byToken(req.params.token);
  if (guest) {
    guest.pushSub = null;
    save();
  }
  res.json({ ok: true });
});

// ----- admin API -----
function requireAdmin(req, res, next) {
  if (req.headers["x-admin-pin"] === ADMIN_PIN) return next();
  res.status(401).json({ error: "Wrong PIN" });
}

app.get("/api/admin/state", requireAdmin, (_req, res) => {
  res.json({
    open: state.open,
    capacity: STORE_CAPACITY,
    slotsAvailable: slotsAvailable(),
    suggestedCall: Math.max(0, suggestedCallCount()),
    counts: {
      waiting: waiting().length,
      called: called().length,
      inStore: inStore().length,
      total: state.guests.length,
    },
    guests: state.guests
      .filter((g) => ["waiting", "called", "inStore"].includes(g.status))
      .sort((a, b) => a.number - b.number)
      .map((g) => ({
        id: g.id,
        number: g.number,
        name: g.name,
        status: g.status,
        calledAt: g.calledAt,
        telegram: !!g.tgChat,
        email: !!g.email,
        push: !!g.pushSub,
      })),
  });
});

// Call the next N waiting guests: marks them "called" and pings them on
// every channel they linked.
app.post("/api/admin/call-next", requireAdmin, (req, res) => {
  const n = Math.min(Math.max(parseInt(req.body.count || "1", 10), 1), 50);
  const room = Math.max(0, slotsAvailable() - called().length);
  if (room === 0) {
    return res.status(409).json({
      error: "Store is at capacity. Mark guests as left before calling more.",
    });
  }
  const toCall = Math.min(n, room);
  const next = waiting()
    .sort((a, b) => a.number - b.number)
    .slice(0, toCall);
  for (const g of next) {
    g.status = "called";
    g.calledAt = Date.now();
    notifyGuest(g, "yourTurn");
  }
  save();
  sweepHeadsUp();
  res.json({ called: next.map((g) => g.number) });
});

app.post("/api/admin/guest/:id", requireAdmin, (req, res) => {
  const guest = byId(req.params.id);
  if (!guest) return res.status(404).json({ error: "Not found" });
  const action = req.body.action;
  if (action === "entered") guest.status = "inStore";
  else if (action === "done") guest.status = "done";
  else if (action === "noshow") guest.status = "noShow";
  else if (action === "requeue") {
    guest.status = "waiting";
    guest.calledAt = null;
    guest.headsUpSent = false; // allow a fresh heads-up on the second lap
  } else return res.status(400).json({ error: "Unknown action" });
  save();
  sweepHeadsUp();
  res.json({ ok: true });
});

app.post("/api/admin/open", requireAdmin, (req, res) => {
  state.open = !!req.body.open;
  save();
  sweepHeadsUp();
  res.json({ open: state.open });
});

app.post("/api/admin/reset", requireAdmin, (_req, res) => {
  state = { seq: 0, guests: [], open: true };
  save();
  sweepHeadsUp();
  res.json({ ok: true });
});

app.get("/admin", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "admin.html"))
);

app.use((err, _req, res, _next) => {
  console.error("Request error:", err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`Paint the Town Maroon queue running on http://localhost:${PORT}`);
  if (!BOT_TOKEN) console.log("TELEGRAM_BOT_TOKEN not set: Telegram notifications disabled.");
  if (EMAIL_ENABLED) {
    console.log("Email notifications: enabled (SMTP)");
    mailer.verify().catch((e) => {
      console.error("SMTP verify failed (emails may not send):", e.message + smtpCertHint(e) + smtpAuthHint(e));
    });
  } else {
    console.log("SMTP not configured: email notifications disabled (set SMTP_HOST, SMTP_USER, SMTP_PASS).");
  }
  if (PUSH_ENABLED) console.log("Push notifications: enabled (VAPID)");
  else console.log("VAPID keys not set: push notifications disabled (run `npm run vapid-keys` and set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY).");
});
