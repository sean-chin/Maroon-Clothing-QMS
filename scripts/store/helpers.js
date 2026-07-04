const VALID_STATUSES = new Set(["waiting", "called", "inStore", "done", "noShow"]);

function normalizeGuest(raw) {
  if (!raw || typeof raw !== "object" || !raw.id || !raw.token) return null;
  const g = { ...raw };
  if (!VALID_STATUSES.has(g.status)) g.status = "done";
  if (typeof g.number !== "number") g.number = 0;
  if (!g.name) g.name = "Guest";
  if (g.headsUpSent == null) g.headsUpSent = !!g.notifiedAlmost;
  if (g.headsUpSent == null) g.headsUpSent = false;
  delete g.notifiedAlmost;
  return g;
}

function rowToGuest(row) {
  if (!row) return null;
  return normalizeGuest({
    id: row.id,
    token: row.token,
    number: row.number,
    name: row.name,
    status: row.status,
    joinedAt: row.joined_at,
    calledAt: row.called_at,
    tgChat: row.tg_chat,
    email: row.email,
    pushSub: row.push_sub,
    headsUpSent: row.heads_up_sent,
  });
}

function guestToRow(g) {
  return {
    id: g.id,
    token: g.token,
    number: g.number,
    name: g.name,
    status: g.status,
    joined_at: g.joinedAt,
    called_at: g.calledAt,
    tg_chat: g.tgChat,
    email: g.email,
    push_sub: g.pushSub,
    heads_up_sent: g.headsUpSent,
  };
}

function normalizeState(raw) {
  if (!raw || typeof raw !== "object") {
    return { seq: 0, guests: [], open: true, tgOffset: 0 };
  }
  const guests = Array.isArray(raw.guests) ? raw.guests : [];
  const normalized = [];
  for (const g of guests) {
    const ng = normalizeGuest(g);
    if (ng) normalized.push(ng);
  }
  return {
    seq: typeof raw.seq === "number" && raw.seq >= 0 ? raw.seq : 0,
    guests: normalized,
    open: raw.open !== false,
    tgOffset: typeof raw.tgOffset === "number" && raw.tgOffset >= 0 ? raw.tgOffset : 0,
  };
}

function partitionGuests(guests) {
  const waiting = [];
  const called = [];
  const inStore = [];
  for (const g of guests) {
    if (g.status === "waiting") waiting.push(g);
    else if (g.status === "called") called.push(g);
    else if (g.status === "inStore") inStore.push(g);
  }
  return { waiting, called, inStore };
}

function positionInfo(guest, waiting, called, guestsPerMinute, almostAhead) {
  const ahead =
    waiting.filter((g) => g.number < guest.number).length + called.length;
  const estMinutes = Math.max(1, Math.round(ahead / guestsPerMinute));
  const aheadMax = Math.max(almostAhead, waiting.length + called.length);
  return { ahead, estMinutes, aheadMax };
}

function guestPhase(guest, waiting, called, almostAhead, guestsPerMinute) {
  if (guest.status === "inStore") return "inStore";
  if (guest.status === "done" || guest.status === "noShow") return "done";
  if (guest.status === "called") return "yourTurn";
  const { ahead } = positionInfo(guest, waiting, called, guestsPerMinute, almostAhead);
  if (ahead <= almostAhead) return "almost";
  return "waiting";
}

function activeGuestCount(guests) {
  return guests.filter(
    (g) => g.status === "waiting" || g.status === "called" || g.status === "inStore"
  ).length;
}

function slotsAvailable(inStoreCount, capacity) {
  return Math.max(0, capacity - inStoreCount);
}

function suggestedCallCount(waitingLen, calledLen, inStoreLen, capacity) {
  const slots = slotsAvailable(inStoreLen, capacity);
  const roomForCalled = Math.max(0, slots - calledLen);
  return Math.min(waitingLen, roomForCalled);
}

module.exports = {
  VALID_STATUSES,
  normalizeGuest,
  rowToGuest,
  guestToRow,
  normalizeState,
  partitionGuests,
  positionInfo,
  guestPhase,
  activeGuestCount,
  slotsAvailable,
  suggestedCallCount,
};
