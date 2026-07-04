const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  normalizeState,
  partitionGuests,
  positionInfo,
  guestPhase,
  computeHeadsUpCandidates,
  activeGuestCount,
  slotsAvailable,
  suggestedCallCount,
} = require("./helpers");

const DATA_DIR = path.join(__dirname, "..", "..", "data");
const DATA_FILE = path.join(DATA_DIR, "queue.json");

let state = { seq: 0, guests: [], open: true };

// Every mutation is written to disk synchronously and immediately: queue
// writes are low-frequency (guest actions, not polls), so there is no
// meaningful cost to trading a debounce window for the guarantee that a
// crash or restart never loses a committed guest-state change.
function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error("Snapshot failed:", e.message);
  }
}

function getPartitions() {
  return partitionGuests(state.guests);
}

async function init() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      state = normalizeState(JSON.parse(fs.readFileSync(DATA_FILE, "utf8")));
      console.log(`Restored queue: ${state.guests.length} guests, seq ${state.seq}`);
    }
  } catch (e) {
    console.error("Could not restore snapshot, starting fresh:", e.message);
  }
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => {
      save();
      process.exit(0);
    });
  }
}

async function shutdown() {
  save();
}

async function getHealth() {
  return { open: state.open, guestCount: state.guests.length };
}

async function isOpen() {
  return state.open;
}

async function join({ name, email }) {
  if (!state.open) {
    const err = new Error("The queue is currently closed.");
    err.code = "queue_closed";
    throw err;
  }
  if (activeGuestCount(state.guests) >= 5000) {
    const err = new Error("Queue is full.");
    err.code = "queue_full";
    throw err;
  }
  state.seq += 1;
  const guest = {
    id: crypto.randomUUID(),
    token: crypto.randomBytes(12).toString("hex"),
    number: state.seq,
    name,
    status: "waiting",
    joinedAt: Date.now(),
    calledAt: null,
    email,
    pushSub: null,
    headsUpSent: false,
  };
  state.guests.push(guest);
  save();
  return guest;
}

async function findByToken(token) {
  return state.guests.find((g) => g.token === token) || null;
}

async function findById(id) {
  return state.guests.find((g) => g.id === id) || null;
}

async function updateGuest(guest) {
  const idx = state.guests.findIndex((g) => g.id === guest.id);
  if (idx >= 0) state.guests[idx] = guest;
  save();
}

async function getStatusPayload(guest, { guestsPerMinute, almostAhead }) {
  const { waiting, called } = getPartitions();
  const { ahead, estMinutes, aheadMax } = positionInfo(
    guest,
    waiting,
    called,
    guestsPerMinute,
    almostAhead
  );
  const phase = guestPhase(guest, waiting, called, almostAhead, guestsPerMinute);
  return {
    number: guest.number,
    name: guest.name,
    status: guest.status,
    phase,
    ahead: phase === "waiting" || phase === "almost" ? ahead : 0,
    estMinutes: phase === "waiting" || phase === "almost" ? estMinutes : 0,
    aheadMax,
    advanceMinutes: 5,
    channels: { email: !!guest.email, push: !!guest.pushSub },
  };
}

async function getAdminState(capacity) {
  const { waiting, called, inStore } = getPartitions();
  const active = state.guests.filter((g) =>
    ["waiting", "called", "inStore"].includes(g.status)
  );
  return {
    open: state.open,
    capacity,
    slotsAvailable: slotsAvailable(inStore.length, capacity),
    suggestedCall: Math.max(
      0,
      suggestedCallCount(waiting.length, called.length, inStore.length, capacity)
    ),
    counts: {
      waiting: waiting.length,
      called: called.length,
      inStore: inStore.length,
      total: state.guests.length,
    },
    guests: active
      .sort((a, b) => a.number - b.number)
      .map((g) => ({
        id: g.id,
        number: g.number,
        name: g.name,
        status: g.status,
        calledAt: g.calledAt,
        email: !!g.email,
        push: !!g.pushSub,
      })),
  };
}

async function callNext(count, capacity) {
  const { waiting, called, inStore } = getPartitions();
  const room = Math.max(0, slotsAvailable(inStore.length, capacity) - called.length);
  if (room === 0) {
    const err = new Error("Store is at capacity. Mark guests as left before calling more.");
    err.code = "store_full";
    throw err;
  }
  const toCall = waiting.sort((a, b) => a.number - b.number).slice(0, Math.min(count, room));
  const now = Date.now();
  for (const g of toCall) {
    g.status = "called";
    g.calledAt = now;
    g.headsUpSent = true;
  }
  save();
  return { called: toCall, numbers: toCall.map((g) => g.number) };
}

async function guestAction(id, action) {
  const guest = await findById(id);
  if (!guest) {
    const err = new Error("Not found");
    err.code = "not_found";
    throw err;
  }
  if (action === "entered") {
    if (guest.status !== "called") {
      const err = new Error("Guest must be called before entering the store.");
      err.code = "bad_status";
      throw err;
    }
    guest.status = "inStore";
  } else if (action === "done") guest.status = "done";
  else if (action === "noshow") guest.status = "noShow";
  else if (action === "requeue") {
    guest.status = "waiting";
    guest.calledAt = null;
    guest.headsUpSent = false;
  } else {
    const err = new Error("Unknown action");
    err.code = "bad_action";
    throw err;
  }
  save();
  return guest;
}

async function setOpen(open) {
  state.open = !!open;
  save();
  return state.open;
}

async function reset() {
  try {
    if (state.guests.length) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const archivePath = path.join(DATA_DIR, `queue-archive-${Date.now()}.json`);
      fs.writeFileSync(archivePath, JSON.stringify(state));
    }
  } catch (e) {
    console.error("Archive before reset failed:", e.message);
  }
  state = { seq: 0, guests: [], open: true };
  save();
}

async function sweepHeadsUp({ almostAhead, onNotify }) {
  const { waiting, called } = getPartitions();
  const candidates = computeHeadsUpCandidates(waiting, called, almostAhead);
  if (!candidates.length) return;
  for (const g of candidates) {
    g.headsUpSent = true;
    onNotify(g);
  }
  save();
}

// Fixed-window rate limiter, per process. Good enough for the single-
// instance file-store deployment; Supabase mode uses a Postgres-backed
// version so limits hold across multiple instances.
const rateLimitState = new Map();
setInterval(() => {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [key, entry] of rateLimitState) {
    if (entry.windowStart < cutoff) rateLimitState.delete(key);
  }
}, 5 * 60_000).unref();

async function hitRateLimit(key, windowMs, max) {
  const now = Date.now();
  const entry = rateLimitState.get(key);
  if (!entry || now - entry.windowStart >= windowMs) {
    rateLimitState.set(key, { windowStart: now, count: 1 });
    return true;
  }
  entry.count += 1;
  return entry.count <= max;
}

module.exports = {
  backend: "file",
  init,
  shutdown,
  getHealth,
  isOpen,
  join,
  findByToken,
  findById,
  updateGuest,
  getStatusPayload,
  getAdminState,
  callNext,
  guestAction,
  setOpen,
  reset,
  sweepHeadsUp,
  hitRateLimit,
};
