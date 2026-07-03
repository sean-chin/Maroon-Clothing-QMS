(function () {
  const $ = (id) => document.getElementById(id);
  const { request, sleep } = window.MaroonAPI;

  let token = localStorage.getItem("maroonToken");
  let pollTimer = null;
  let pollInFlight = false;
  let lastPhase = null;
  let queueOpen = true;
  let failStreak = 0;

  const PHASE_LABELS = {
    waiting: "In line",
    almost: "Almost there",
    yourTurn: "Walk in now",
    inStore: "You're in",
    done: "Done",
  };

  function setConn(ok) {
    const dot = $("connDot");
    const label = $("connLabel");
    if (!dot) return;
    dot.classList.toggle("ok", ok);
    dot.classList.toggle("bad", !ok);
    if (label) label.textContent = ok ? "Live" : "Reconnecting";
  }

  function setLoading(btn, loading) {
    if (!btn) return;
    btn.disabled = loading;
    btn.classList.toggle("loading", loading);
  }

  function applyPhase(phase) {
    const pill = $("statusPill");
    if (!pill) return;
    pill.textContent = PHASE_LABELS[phase] || phase;
    pill.className = "status-pill phase-" + phase;

    $("waitPanel").hidden =
      phase === "inStore" || phase === "done" || phase === "yourTurn";
    $("inStorePanel").hidden = phase !== "inStore";
    $("advancePanel").hidden = phase !== "almost";
    $("turnPanel").hidden = phase !== "yourTurn";

    const qNum = $("qNumber");
    if (qNum) {
      qNum.classList.toggle("queue-hot", phase === "yourTurn");
      qNum.classList.toggle("queue-warm", phase === "almost");
    }

    if (phase === "almost" && lastPhase !== "almost") {
      $("advancePanel").classList.add("pulse-once");
      setTimeout(() => $("advancePanel").classList.remove("pulse-once"), 2000);
    }
    if (phase === "yourTurn" && lastPhase !== "yourTurn") {
      $("turnPanel").classList.add("pulse-once");
      setTimeout(() => $("turnPanel").classList.remove("pulse-once"), 2000);
    }
    lastPhase = phase;
  }

  async function loadConfig() {
    try {
      const cfg = await request("/api/config", { retries: 2 });
      queueOpen = cfg.open;
      $("eventCapacity").textContent = cfg.capacity;
      if (!cfg.open) {
        $("joinCard").hidden = true;
        $("closedCard").hidden = false;
      }
    } catch {
      setConn(false);
    }
  }

  function showStatusView() {
    $("joinCard").hidden = true;
    $("closedCard").hidden = true;
    $("statusCard").hidden = false;
    startPolling();
  }

  async function joinQueue() {
    $("joinError").textContent = "";
    const name = ($("name").value || "").trim();
    if (!name) {
      $("joinError").textContent = "Drop your name so we know it's you.";
      return;
    }
    setLoading($("joinBtn"), true);
    try {
      const j = await request("/api/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      token = j.token;
      localStorage.setItem("maroonToken", token);
      showStatusView();
    } catch (e) {
      $("joinError").textContent = e.message;
    } finally {
      setLoading($("joinBtn"), false);
    }
  }

  async function pollOnce() {
    if (!token || pollInFlight) return;
    pollInFlight = true;
    try {
      const s = await request("/api/status/" + token, { retries: 1 });
      failStreak = 0;
      setConn(true);

      $("qNumber").textContent = s.number;
      $("guestName").textContent = s.name;
      $("ahead").textContent = s.ahead;
      $("est").textContent = s.estMinutes;

      const bar = $("progressBar");
      if (bar && s.aheadMax) {
        const pct = Math.max(8, 100 - (s.ahead / s.aheadMax) * 100);
        bar.style.width = pct + "%";
      }

      applyPhase(s.phase);

      if (s.phase === "done") {
        stopPolling();
        localStorage.removeItem("maroonToken");
        $("statusCard").hidden = true;
        $("thanksCard").hidden = false;
      }
    } catch (e) {
      failStreak += 1;
      setConn(false);
      if (e.status === 404 || failStreak >= 8) {
        stopPolling();
        localStorage.removeItem("maroonToken");
        token = null;
        $("statusCard").hidden = true;
        $("joinCard").hidden = !queueOpen;
        $("closedCard").hidden = queueOpen;
        $("sessionError").hidden = false;
      }
    } finally {
      pollInFlight = false;
    }
  }

  function startPolling() {
    stopPolling();
    pollOnce();
    pollTimer = setInterval(pollOnce, 4000);
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  async function leaveQueue() {
    if (!confirm("Leave the line? You'll lose your spot.")) return;
    setLoading($("leaveBtn"), true);
    try {
      await request("/api/leave/" + token, { method: "POST" });
    } catch {
      /* still clear local session */
    }
    stopPolling();
    localStorage.removeItem("maroonToken");
    token = null;
    location.reload();
  }

  $("joinBtn")?.addEventListener("click", joinQueue);
  $("name")?.addEventListener("keydown", (e) => e.key === "Enter" && joinQueue());
  $("leaveBtn")?.addEventListener("click", leaveQueue);
  $("retryBtn")?.addEventListener("click", () => location.reload());

  loadConfig().then(() => {
    if (token) showStatusView();
  });
})();
