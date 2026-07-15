# Queue Event Prep — Conversation Summary

**Date:** 11 July 2026  
**Branch:** `cursor/unlimited-calls-qr-pings-94b7`  
**PR:** [#10](https://github.com/sean-chin/Maroon-Clothing-QMS/pull/10) (Unlimited call-ins, faster pings, and fresh QR code)  
**App:** Paint the Town Maroon Queue Manager (`maroon-clothing-qms`)

---

## What was requested

For the next event day, staff needed three things:

1. A **fresh QR code** for guests to join the queue
2. Ability to **call an unlimited number of people** into the store at once (not capped by store capacity)
3. **More frequent pings and reminders** so guests get earlier heads-ups

Follow-ups during the session:

4. Set **store capacity display to 30**
5. **Verify** there is no call-in limit
6. Confirm capacity is 30, **push to git**, and **redeploy**

---

## Changes made

### 1. Unlimited call-ins

Previously, `call-next` was gated by store capacity (`inStore + called` could not exceed `STORE_CAPACITY`). Managers hit a “store full” error when trying to call more people than remaining slots.

**After this work:**

- Calling is limited **only** by how many guests are waiting
- You can call 1, 50, or all waiting guests in one action
- Store capacity still shows on the admin dashboard (in-store bar / slots free) but **does not block call-ins**

| Layer | Change |
|-------|--------|
| `scripts/store/file.js` | `callNext(count)` — no capacity room check |
| `scripts/store/supabase.js` | RPC call no longer passes `p_capacity` |
| `scripts/store/helpers.js` | `suggestedCallCount` suggests all waiting guests |
| `server.js` | Removed max-count clamp of 50; handles `queue_empty` instead of `store_full` |
| Admin UI | Hint text says no capacity limit; call input has no `max` |
| Supabase | Migration `20260711120000_unlimited_call_next.sql` replaces `maroon_call_next` |

**Live test (local):** Joined 35 guests, filled 5 as in-store, then called `999` — all 30 remaining waiting guests were called with no error.

### 2. Faster pings and reminders

| Setting | Before | After |
|---------|--------|-------|
| `ALMOST_AHEAD` | 10 guests ahead | **25** (heads-up fires earlier) |
| `ADVANCE_MINUTES` | 5 (hardcoded) | **3** (env-driven copy) |
| `GUESTS_PER_MINUTE` | 2 | **3** |
| Heads-up sweep | Only on queue events | Also every **20s** (`HEADS_UP_SWEEP_MS`) |
| Guest page poll | 4s | **2s** |
| Admin dashboard refresh | 3s | **2s** |

Guests still get at most one heads-up (`headsUpSent`) plus a “your turn” ping when called.

### 3. Fresh QR code

There was previously no in-app QR — staff were expected to generate one externally.

**Added:**

- QR section on the **admin dashboard** (`/admin`) after PIN unlock
- Printable page at **`/qr`**
- CLI: `PUBLIC_URL=https://your-live-url npm run qr` → writes `public/assets/queue-qr.svg`
- API: `GET /api/admin/qr` (PIN-protected) returns join URL + SVG
- Optional env: `PUBLIC_URL` so QR codes point at production

### 4. Store capacity default → 30

| Location | Value |
|----------|-------|
| `server.js` default | `STORE_CAPACITY \|\| "30"` |
| `.env.example` | `STORE_CAPACITY=30` |
| `public/admin.html` | Label placeholder `0 / 30` |
| `public/js/admin.js` | Initial `capacity = 30` |

Capacity remains **display-only** for in-store occupancy. It does not limit call-ins.

---

## Commits on feature branch

1. `ff61d2a` — Unlimited call-ins, faster pings, and admin QR code  
2. `b5dae40` — Set default store capacity to 30  

---

## Env vars (new / updated defaults)

| Variable | Default | Purpose |
|----------|---------|---------|
| `STORE_CAPACITY` | `30` | Physical store size shown on dashboard |
| `ALMOST_AHEAD` | `25` | Heads-up when this many (or fewer) are ahead |
| `ADVANCE_MINUTES` | `3` | Copy for the heads-up window |
| `GUESTS_PER_MINUTE` | `3` | Wait estimate rate |
| `HEADS_UP_SWEEP_MS` | `20000` | Periodic heads-up sweep interval |
| `PUBLIC_URL` | _(request host)_ | Base URL for QR generation |

---

## Deploy checklist

- [ ] Merge / deploy branch `cursor/unlimited-calls-qr-pings-94b7` to production
- [ ] If using Supabase: run `supabase/migrations/20260711120000_unlimited_call_next.sql` in the SQL editor
- [ ] Set `PUBLIC_URL` to the live guest URL (e.g. `https://maroon-clothing-qms.vercel.app`)
- [ ] Confirm Vercel env `STORE_CAPACITY=30` if that var is set (env overrides code default)
- [ ] In `/admin`: **Reset entire queue** for a fresh day
- [ ] Print QR from the admin **Guest QR code** card or open `/qr`

### Verify after deploy

```bash
curl -s https://maroon-clothing-qms.vercel.app/api/config
# Expect: "capacity":30, "advanceMinutes":3
```

---

## Note on git / production state

During this session, capacity **30** and unlimited call-ins were confirmed live on production at one point (`/api/config` returned `"capacity":30`). If `main` has since moved or been reset without these commits, re-merge the feature branch (or cherry-pick `ff61d2a` + `b5dae40`) before the next event so production matches this summary.
