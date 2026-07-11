(function () {
  const $ = (id) => document.getElementById(id);
  const { request } = window.MaroonAPI;

  let pin = sessionStorage.getItem("maroonPin") || "";
  let isOpen = true;
  let refreshTimer = null;
  let refreshInFlight = false;
  let capacity = 30;

  function toast(msg, type) {
    const el = $("toast");
    if (!el) return;
    el.textContent = msg;
    el.className = "toast show" + (type ? " " + type : "");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove("show"), 3200);
  }

  function setLoading(btn, on) {
    if (!btn) return;
    btn.disabled = on;
    btn.classList.toggle("loading", on);
  }

  async function api(path, body) {
    return request(path, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", "X-Admin-Pin": pin },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  function actions(g) {
    const b = (a, label, cls) =>
      `<button type="button" class="row-btn ${cls || ""}" data-id="${g.id}" data-action="${a}">${label}</button>`;
    if (g.status === "waiting")
      return b("noshow", "Remove", "secondary");
    if (g.status === "called")
      return (
        b("entered", "Entered") +
        b("noshow", "No-show", "secondary") +
        b("requeue", "Re-queue", "secondary")
      );
    if (g.status === "inStore") return b("done", "Left store");
    return "";
  }

  function updateCapacityBar(inStore, cap) {
    const pct = Math.min(100, Math.round((inStore / cap) * 100));
    $("capBar").style.width = pct + "%";
    $("capBar").classList.toggle("full", inStore >= cap);
    $("capLabel").textContent = inStore + " / " + cap;
  }

  async function refresh() {
    if (refreshInFlight) return;
    refreshInFlight = true;
    $("refreshDot").classList.remove("ok");
    try {
      const s = await api("/api/admin/state");
      isOpen = s.open;
      capacity = s.capacity;

      $("sWaiting").textContent = s.counts.waiting;
      $("sCalled").textContent = s.counts.called;
      $("sInStore").textContent = s.counts.inStore;
      $("sTotal").textContent = s.counts.total;
      $("sSlots").textContent = s.slotsAvailable;

      updateCapacityBar(s.counts.inStore, s.capacity);

      const suggested = s.suggestedCall || 0;
      $("callCount").value = suggested || 1;
      $("callHint").textContent =
        s.counts.waiting > 0
          ? `${s.counts.waiting} waiting. Suggested call: ${suggested || 0} (no capacity limit).`
          : "No one waiting to call in.";

      $("openBtn").textContent = isOpen ? "Close new joins" : "Reopen queue";
      $("openBtn").classList.toggle("warn", isOpen);
      $("queueState").textContent = isOpen ? "Open" : "Closed";
      $("queueState").className = "queue-state " + (isOpen ? "open" : "closed");

      const rows = s.guests;
      $("rows").innerHTML = rows.length
        ? rows
            .map((g) => {
              // Golden ticket: every 25th number wins a surprise at the door
              const gold = g.number % 25 === 0 && g.number !== 0;
              return `<tr${gold ? ' class="gold-row"' : ""}>
        <td class="num">${g.number}${gold ? '<span class="gold-chip">Gold</span>' : ""}</td>
        <td>${esc(g.name)}${g.push ? '<span class="chip" title="Gets push notifications">PUSH</span>' : ""}${g.email ? '<span class="chip" title="Gets email pings">@</span>' : ""}</td>
        <td>${esc(g.phone || "")}</td>
        <td><span class="pill ${g.status}">${g.status}</span></td>
        <td>${actions(g)}</td>
      </tr>`;
            })
            .join("")
        : `<tr><td colspan="5" class="empty">Queue's empty right now.</td></tr>`;

      $("refreshDot").classList.add("ok");
    } catch (e) {
      if (e.status === 401) {
        sessionStorage.removeItem("maroonPin");
        location.reload();
        return;
      }
      toast(e.message || "Could not refresh", "error");
    } finally {
      refreshInFlight = false;
    }
  }

  async function guestAction(id, action) {
    try {
      await api("/api/admin/guest/" + id, { action });
      toast("Updated");
      await refresh();
    } catch (e) {
      toast(e.message || "Action failed", "error");
    }
  }

  $("rows")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    guestAction(btn.dataset.id, btn.dataset.action);
  });

  $("callBtn")?.addEventListener("click", async () => {
    setLoading($("callBtn"), true);
    try {
      const count = parseInt($("callCount").value, 10) || 1;
      const r = await api("/api/admin/call-next", { count });
      toast("Called queue #" + (r.called || []).join(", #"));
      await refresh();
    } catch (e) {
      toast(e.message || "Call failed", "error");
    } finally {
      setLoading($("callBtn"), false);
    }
  });

  $("openBtn")?.addEventListener("click", async () => {
    setLoading($("openBtn"), true);
    try {
      await api("/api/admin/open", { open: !isOpen });
      toast(isOpen ? "Queue closed to new joins" : "Queue reopened");
      await refresh();
    } catch (e) {
      toast(e.message || "Could not update", "error");
    } finally {
      setLoading($("openBtn"), false);
    }
  });

  $("resetBtn")?.addEventListener("click", async () => {
    if (!confirm("Reset the ENTIRE queue? All guests will be removed.")) return;
    if (!confirm("Are you sure? This cannot be undone.")) return;
    setLoading($("resetBtn"), true);
    try {
      await api("/api/admin/reset", {});
      toast("Queue reset");
      await refresh();
    } catch (e) {
      toast(e.message || "Reset failed", "error");
    } finally {
      setLoading($("resetBtn"), false);
    }
  });

  async function unlock() {
    $("pinError").textContent = "";
    pin = $("pin").value;
    setLoading($("pinBtn"), true);
    try {
      await api("/api/admin/state");
      sessionStorage.setItem("maroonPin", pin);
      $("pinCard").hidden = true;
      $("dash").hidden = false;
      await refresh();
      await loadQr();
      refreshTimer = setInterval(refresh, 2000);
    } catch {
      $("pinError").textContent = "Wrong PIN. Try again.";
    } finally {
      setLoading($("pinBtn"), false);
    }
  }

  $("pinBtn")?.addEventListener("click", unlock);
  $("pin")?.addEventListener("keydown", (e) => e.key === "Enter" && unlock());

  $("pinToggle")?.addEventListener("click", () => {
    const input = $("pin");
    const toggle = $("pinToggle");
    const reveal = input.type === "password";
    input.type = reveal ? "text" : "password";
    toggle.textContent = reveal ? "Hide" : "Show";
    toggle.setAttribute("aria-pressed", String(reveal));
    toggle.setAttribute("aria-label", reveal ? "Hide PIN" : "Show PIN");
    input.focus();
  });

  async function loadQr() {
    const box = $("qrBox");
    const urlEl = $("qrUrl");
    if (!box) return;
    try {
      const r = await api("/api/admin/qr");
      box.innerHTML = r.svg;
      if (urlEl) urlEl.textContent = r.url;
    } catch (e) {
      box.innerHTML = `<p class="error">${esc(e.message || "Could not load QR")}</p>`;
    }
  }

  $("qrPrintBtn")?.addEventListener("click", () => window.open("/qr", "_blank"));
  $("qrRefreshBtn")?.addEventListener("click", loadQr);

  if (pin) {
    $("pin").value = pin;
    unlock();
  } else {
    $("pin")?.focus();
  }
})();
