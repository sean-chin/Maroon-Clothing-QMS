/*
 * Maroon Clothing - "Paint the Town Maroon" pop-up queue manager.
 *
 * Single-process Express server. All state lives in memory and is
 * snapshotted atomically to data/queue.json on every change, so a crash
 * or restart never loses the queue. Guests poll their status; the queue
 * manager drives the queue from /admin.
 *
 * Notifications: UI shows ~5 min heads-up states on the guest page.
 * Telegram hooks remain for future use but are not required.
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

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

const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "queue.json");

// ---------- state + persistence ----------
let state = {
  seq: 0, // last issued queue number
  guests: [], // {id, token, number, name, status, joinedAt, calledAt, tgChat}
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

function notifyGuest(guest, text) {
  if (!guest.tgChat) return;
  // Fire-and-forget with one retry so a Telegram hiccup never blocks the queue.
  tgApi("sendMessage", { chat_id: guest.tgChat, text }).then((r) => {
    if (!r || !r.ok) {
      setTimeout(() => tgApi("sendMessage", { chat_id: guest.tgChat, text }), 3000);
    }
  });
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
            notifyGuest(
              guest,
              `You're linked! You are number ${guest.number} in the Paint the Town Maroon queue. We'll message you here about 5 minutes before your turn. Feel free to roam the mall.`
            );
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
  };
  state.guests.push(guest);
  save();
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
  });
});

app.post("/api/leave/:token", rateLimit(10), (req, res) => {
  const guest = byToken(req.params.token);
  if (guest && (guest.status === "waiting" || guest.status === "called")) {
    guest.status = "done";
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
      })),
  });
});

// Call the next N waiting guests: marks them "called" and sends the
// 5-minute heads-up on Telegram.
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
    notifyGuest(
      g,
      `It's almost your turn! Queue number ${g.number}: please make your way to the Maroon store now. You'll be let in within about 5 minutes. See you soon!`
    );
  }
  save();
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
  } else return res.status(400).json({ error: "Unknown action" });
  save();
  res.json({ ok: true });
});

app.post("/api/admin/open", requireAdmin, (req, res) => {
  state.open = !!req.body.open;
  save();
  res.json({ open: state.open });
});

app.post("/api/admin/reset", requireAdmin, (_req, res) => {
  state = { seq: 0, guests: [], open: true };
  save();
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
  if (!BOT_TOKEN) console.log("TELEGRAM_BOT_TOKEN not set: Telegram notifications disabled (browser notifications still work).");
});
