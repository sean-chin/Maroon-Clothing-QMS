const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const {
  rowToGuest,
  guestToRow,
  partitionGuests,
  positionInfo,
  guestPhase,
  slotsAvailable,
  suggestedCallCount,
  normalizeGuest,
} = require("./helpers");

const SUPABASE_URL = process.env.SUPABASE_URL || "";
// Legacy JWT service_role or new sb_secret_... key (Settings → API Keys → Secret keys).
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  "";

let supabase = null;

function assertServiceRoleKey(key) {
  if (!key) return;
  if (key.startsWith("sb_publishable_")) {
    throw new Error(
      "Supabase key is a publishable key. Create a Secret key at Settings → API Keys (sb_secret_...) or use Legacy service_role."
    );
  }
  if (key.startsWith("sb_secret_")) return;
  const parts = key.split(".");
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
      if (payload.role === "anon") {
        throw new Error(
          "Supabase key is the anon JWT. Use a Secret key (sb_secret_...) or Legacy service_role from Settings → API Keys."
        );
      }
    } catch (e) {
      if (e.message.includes("anon JWT")) throw e;
    }
  }
}

function client() {
  if (!supabase) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
    }
    assertServiceRoleKey(SUPABASE_SERVICE_ROLE_KEY);
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return supabase;
}

async function getSettings() {
  const { data, error } = await client()
    .from("queue_settings")
    .select("seq, open, tg_offset")
    .eq("id", 1)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    await client().from("queue_settings").insert({ id: 1 });
    return { seq: 0, open: true, tgOffset: 0 };
  }
  return { seq: data.seq, open: data.open, tgOffset: data.tg_offset };
}

async function loadActiveGuests() {
  const { data, error } = await client()
    .from("guests")
    .select("*")
    .in("status", ["waiting", "called", "inStore"]);
  if (error) throw error;
  return (data || []).map(rowToGuest);
}

async function init() {
  await getSettings();
  console.log("Queue store: Supabase (Postgres)");
}

async function getHealth() {
  const settings = await getSettings();
  const { count, error } = await client().from("guests").select("*", { count: "exact", head: true });
  if (error) throw error;
  return { open: settings.open, guestCount: count || 0 };
}

async function isOpen() {
  return (await getSettings()).open;
}

async function getTgOffset() {
  return (await getSettings()).tgOffset;
}

async function setTgOffset(offset) {
  const { error } = await client().from("queue_settings").update({ tg_offset: offset }).eq("id", 1);
  if (error) throw error;
}

async function join({ name, email }) {
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(12).toString("hex");
  const { data, error } = await client().rpc("maroon_join_guest", {
    p_id: id,
    p_token: token,
    p_name: name,
    p_email: email,
  });
  if (error) {
    if (error.message.includes("queue_closed")) {
      const err = new Error("The queue is currently closed.");
      err.code = "queue_closed";
      throw err;
    }
    if (error.message.includes("queue_full")) {
      const err = new Error("Queue is full.");
      err.code = "queue_full";
      throw err;
    }
    throw error;
  }
  return normalizeGuest(data);
}

async function findByToken(token) {
  const { data, error } = await client().from("guests").select("*").eq("token", token).maybeSingle();
  if (error) throw error;
  return rowToGuest(data);
}

async function findById(id) {
  const { data, error } = await client().from("guests").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return rowToGuest(data);
}

async function updateGuest(guest) {
  const { error } = await client().from("guests").update(guestToRow(guest)).eq("id", guest.id);
  if (error) throw error;
}

async function getStatusPayload(guest, { guestsPerMinute, almostAhead }) {
  const active = await loadActiveGuests();
  const { waiting, called } = partitionGuests(active);
  return {
    number: guest.number,
    name: guest.name,
    status: guest.status,
    phase: guestPhase(guest, waiting, called, almostAhead, guestsPerMinute),
    ...(() => {
      const { ahead, estMinutes, aheadMax } = positionInfo(
        guest,
        waiting,
        called,
        guestsPerMinute,
        almostAhead
      );
      const phase = guestPhase(guest, waiting, called, almostAhead, guestsPerMinute);
      return {
        ahead: phase === "waiting" || phase === "almost" ? ahead : 0,
        estMinutes: phase === "waiting" || phase === "almost" ? estMinutes : 0,
        aheadMax,
      };
    })(),
    advanceMinutes: 5,
    channels: { telegram: !!guest.tgChat, email: !!guest.email, push: !!guest.pushSub },
  };
}

async function getAdminState(capacity) {
  const settings = await getSettings();
  const active = await loadActiveGuests();
  const { waiting, called, inStore } = partitionGuests(active);
  const { count: total, error } = await client()
    .from("guests")
    .select("*", { count: "exact", head: true });
  if (error) throw error;
  return {
    open: settings.open,
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
      total: total || 0,
    },
    guests: active
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
  };
}

async function callNext(count, capacity) {
  const { data, error } = await client().rpc("maroon_call_next", {
    p_count: count,
    p_capacity: capacity,
  });
  if (error) {
    if (error.message.includes("store_full")) {
      const err = new Error("Store is at capacity. Mark guests as left before calling more.");
      err.code = "store_full";
      throw err;
    }
    throw error;
  }
  const numbers = Array.isArray(data) ? data : [];
  if (!numbers.length) return { called: [], numbers: [] };
  const { data: rows, error: fetchErr } = await client()
    .from("guests")
    .select("*")
    .in("number", numbers);
  if (fetchErr) throw fetchErr;
  const called = (rows || []).map(rowToGuest);
  return { called, numbers };
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
  await updateGuest(guest);
  return guest;
}

async function setOpen(open) {
  const { error } = await client().from("queue_settings").update({ open: !!open }).eq("id", 1);
  if (error) throw error;
  return !!open;
}

async function reset() {
  const offset = await getTgOffset();
  const { error } = await client().rpc("maroon_reset_queue");
  if (error) throw error;
  await setTgOffset(offset);
}

async function sweepHeadsUp({ almostAhead, guestsPerMinute, onNotify }) {
  const active = await loadActiveGuests();
  const { waiting, called } = partitionGuests(active);
  for (const g of waiting) {
    if (g.headsUpSent) continue;
    const { ahead } = positionInfo(g, waiting, called, guestsPerMinute, almostAhead);
    if (ahead <= almostAhead) {
      g.headsUpSent = true;
      await updateGuest(g);
      onNotify(g);
    }
  }
}

async function linkTelegram(token, chatId) {
  const guest = await findByToken(token);
  if (!guest) return null;
  guest.tgChat = chatId;
  await updateGuest(guest);
  return guest;
}

module.exports = {
  backend: "supabase",
  init,
  getHealth,
  isOpen,
  getTgOffset,
  setTgOffset,
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
  linkTelegram,
};
