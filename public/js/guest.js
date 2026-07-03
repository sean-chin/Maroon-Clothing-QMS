(function () {
  const $ = (id) => document.getElementById(id);
  const { request, sleep } = window.MaroonAPI;

  let token = localStorage.getItem("maroonToken");
  let pollTimer = null;
  let pollInFlight = false;
  let lastPhase = null;
  let queueOpen = true;
  let failStreak = 0;

  // Notification channels
  let botUsername = "";
  let emailEnabled = false;
  let knownEmail = localStorage.getItem("maroonEmail") || "";
  let emailLinked = false;
  let emailEditing = false;
  let audioCtx = null;
  let userGestured = false;
  const baseTitle = document.title;

  const PHASE_LABELS = {
    waiting: "In line",
    almost: "Almost there",
    yourTurn: "Walk in now",
    inStore: "You're in",
    done: "Done",
  };

  const ALERT_COPY = {
    almost: {
      title: "You're almost up!",
      body: "Start making your way back to Maroon, about 5 minutes to go.",
    },
    yourTurn: {
      title: "It's your turn!",
      body: "Head to the Maroon entrance now, the team's ready for you.",
    },
  };

  // Browsers only allow sound after a user gesture, so grab the first one
  // and set up the audio context while we're allowed to.
  function primeAudio() {
    userGestured = true;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx && !audioCtx) audioCtx = new Ctx();
      if (audioCtx && audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    } catch {
      /* no audio, no drama */
    }
  }
  ["pointerdown", "keydown"].forEach((ev) =>
    document.addEventListener(ev, primeAudio, { once: true })
  );

  // Short two-tone chime via WebAudio, no asset files needed.
  function playChime() {
    if (!userGestured || !audioCtx) return;
    try {
      if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
      const t = audioCtx.currentTime + 0.02;
      [
        [880, t, 0.2],
        [1174.66, t + 0.24, 0.32],
      ].forEach(([freq, start, dur]) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.22, start + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(start);
        osc.stop(start + dur + 0.05);
      });
    } catch (e) {
      console.error("Chime failed:", e);
    }
  }

  // Fire the local device alerts for a phase change: system notification,
  // vibration, chime. Every piece is best-effort and guarded.
  function pingDevice(kind) {
    const copy = ALERT_COPY[kind];
    if (!copy) return;
    try {
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification(copy.title, {
          body: copy.body,
          icon: "assets/badge-oval.png",
          tag: "maroon-queue",
        });
      }
    } catch (e) {
      console.error("Notification failed:", e);
    }
    try {
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    } catch {
      /* ignore */
    }
    playChime();
  }

  function reflectNotifPermission() {
    const btn = $("notifBtn");
    const stateEl = $("notifState");
    if (!btn || !stateEl) return;
    if (!("Notification" in window)) {
      btn.hidden = true;
      stateEl.hidden = false;
      stateEl.textContent = "Not on this browser";
      return;
    }
    const p = Notification.permission;
    if (p === "granted") {
      btn.hidden = true;
      stateEl.hidden = false;
      stateEl.textContent = "On";
      stateEl.classList.add("linked");
    } else if (p === "denied") {
      btn.hidden = true;
      stateEl.hidden = false;
      stateEl.textContent = "Blocked in browser";
      stateEl.classList.remove("linked");
    } else {
      btn.hidden = false;
      stateEl.hidden = true;
    }
  }

  function updateEmailRow() {
    if (!emailEnabled) return;
    $("rowEmail").hidden = false;
    const showLinked = emailLinked && !emailEditing;
    $("emailLinked").hidden = !showLinked;
    $("emailForm").hidden = showLinked;
    if (showLinked) $("emailAddr").textContent = knownEmail || "email saved";
  }

  function updateChannelRows(channels) {
    if (botUsername && token) {
      $("rowTelegram").hidden = false;
      $("tgLink").href = "https://t.me/" + botUsername + "?start=" + token;
      const linked = !!(channels && channels.telegram);
      $("tgLink").hidden = linked;
      $("tgState").hidden = !linked;
    }
    if (channels) emailLinked = !!channels.email;
    updateEmailRow();
    reflectNotifPermission();
  }

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
      pingDevice("almost");
    }
    if (phase === "yourTurn" && lastPhase !== "yourTurn") {
      $("turnPanel").classList.add("pulse-once");
      setTimeout(() => $("turnPanel").classList.remove("pulse-once"), 2000);
      pingDevice("yourTurn");
    }

    document.title = phase === "yourTurn" ? "YOUR TURN | Maroon" : baseTitle;
    $("notifyCard").hidden = phase === "inStore" || phase === "done";
    lastPhase = phase;
  }

  async function loadConfig() {
    try {
      const cfg = await request("/api/config", { retries: 2 });
      queueOpen = cfg.open;
      botUsername = cfg.botUsername || "";
      emailEnabled = !!cfg.emailEnabled;
      $("eventCapacity").textContent = cfg.capacity;
      $("joinEmailField").hidden = !emailEnabled;
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
    $("notifyCard").hidden = false;
    $("lineupCard").hidden = false;
    updateChannelRows(null);
    startPolling();
  }

  async function joinQueue() {
    $("joinError").textContent = "";
    const name = ($("name").value || "").trim();
    if (!name) {
      $("joinError").textContent = "Drop your name so we know it's you.";
      return;
    }
    const email = emailEnabled ? ($("joinEmail").value || "").trim().toLowerCase() : "";
    setLoading($("joinBtn"), true);
    try {
      const j = await request("/api/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(email ? { name, email } : { name }),
      });
      token = j.token;
      localStorage.setItem("maroonToken", token);
      if (email) {
        knownEmail = email;
        localStorage.setItem("maroonEmail", email);
      }
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

      // The Maroon Ticket: every 25th number in line is golden
      if (window.MaroonTicket) {
        const golden = s.number % 25 === 0 && s.number !== 0;
        window.MaroonTicket.render(s.number, s.name, golden);
      }
      $("ahead").textContent = s.ahead;
      $("est").textContent = s.estMinutes;

      const bar = $("progressBar");
      if (bar && s.aheadMax) {
        const pct = Math.max(8, 100 - (s.ahead / s.aheadMax) * 100);
        bar.style.width = pct + "%";
      }

      applyPhase(s.phase);
      updateChannelRows(s.channels);

      if (s.phase === "done") {
        stopPolling();
        localStorage.removeItem("maroonToken");
        $("statusCard").hidden = true;
        $("notifyCard").hidden = true;
        $("lineupCard").hidden = true;
        $("thanksCard").hidden = false;
        window.MaroonTicket?.hide();
      }
    } catch (e) {
      failStreak += 1;
      setConn(false);
      if (e.status === 404 || failStreak >= 8) {
        stopPolling();
        localStorage.removeItem("maroonToken");
        token = null;
        $("statusCard").hidden = true;
        $("notifyCard").hidden = true;
        $("lineupCard").hidden = true;
        $("joinCard").hidden = !queueOpen;
        $("closedCard").hidden = queueOpen;
        $("sessionError").hidden = false;
        window.MaroonTicket?.hide();
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

  async function saveEmail() {
    if (!token) return;
    const val = ($("emailInput").value || "").trim();
    $("emailMsg").textContent = "";
    setLoading($("emailSaveBtn"), true);
    try {
      const r = await request("/api/contact/" + token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: val }),
        retries: 0,
      });
      knownEmail = r.email || "";
      emailLinked = !!r.email;
      emailEditing = false;
      if (knownEmail) localStorage.setItem("maroonEmail", knownEmail);
      else localStorage.removeItem("maroonEmail");
      updateEmailRow();
      $("emailMsg").textContent = r.email
        ? "Locked in! We'll hit your inbox when it's time."
        : "Email cleared. You're browser-only for now.";
    } catch (e) {
      $("emailMsg").textContent = e.message || "That didn't save. Give it another go!";
    } finally {
      setLoading($("emailSaveBtn"), false);
    }
  }

  $("joinBtn")?.addEventListener("click", joinQueue);
  $("name")?.addEventListener("keydown", (e) => e.key === "Enter" && joinQueue());
  $("joinEmail")?.addEventListener("keydown", (e) => e.key === "Enter" && joinQueue());
  $("leaveBtn")?.addEventListener("click", leaveQueue);
  $("retryBtn")?.addEventListener("click", () => location.reload());

  $("notifBtn")?.addEventListener("click", async () => {
    try {
      if ("Notification" in window) await Notification.requestPermission();
    } catch (e) {
      console.error("Permission request failed:", e);
    }
    reflectNotifPermission();
  });

  $("emailSaveBtn")?.addEventListener("click", saveEmail);
  $("emailInput")?.addEventListener("keydown", (e) => e.key === "Enter" && saveEmail());
  $("emailChangeBtn")?.addEventListener("click", () => {
    emailEditing = true;
    $("emailInput").value = knownEmail;
    updateEmailRow();
    $("emailInput").focus();
  });

  loadConfig().then(() => {
    if (token) showStatusView();
  });
})();
