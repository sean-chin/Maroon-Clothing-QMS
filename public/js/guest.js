(function () {
  const $ = (id) => document.getElementById(id);
  const { request, sleep } = window.MaroonAPI;

  let token = localStorage.getItem("maroonToken");
  let pollTimer = null;
  let pollInFlight = false;
  function phaseStorageKey() {
    return token ? "maroonPhase:" + token : null;
  }

  function loadStoredPhase() {
    const k = phaseStorageKey();
    return k ? sessionStorage.getItem(k) : null;
  }

  function storePhase(phase) {
    const k = phaseStorageKey();
    if (k) sessionStorage.setItem(k, phase);
  }
  let lastPhase = loadStoredPhase();
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

  // Push notifications work even with the tab closed (Android straight
  // away, iOS once the page is added to the home screen). The service
  // worker also lets us show local alerts the way Android requires.
  let swReg = null;
  let vapidPublicKey = "";
  let pushSubInFlight = false;
  let lastPushAttempt = 0;
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => {
        swReg = reg;
      })
      .catch((e) => console.error("Service worker registration failed:", e));
  }

  function isIos() {
    return (
      /iphone|ipad|ipod/i.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
    );
  }
  function isStandalone() {
    return (
      window.matchMedia("(display-mode: standalone)").matches ||
      window.navigator.standalone === true
    );
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }

  // Subscribe this browser to push and hand the subscription to the
  // server. Safe to call repeatedly: getSubscription() returns the
  // existing one instead of prompting again.
  async function subscribeToPush() {
    if (pushSubInFlight || !swReg || !vapidPublicKey || !token) return;
    pushSubInFlight = true;
    try {
      let sub = await swReg.pushManager.getSubscription();
      if (!sub) {
        sub = await swReg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
        });
      }
      await request("/api/push/subscribe/" + token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON ? sub.toJSON() : sub }),
        retries: 1,
      });
    } catch (e) {
      console.error("Push subscribe failed:", e);
    } finally {
      pushSubInFlight = false;
    }
  }

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
        const opts = { body: copy.body, icon: "assets/badge-oval.png", tag: "maroon-queue" };
        // Android requires an active service worker to show notifications at
        // all; new Notification() throws there. Prefer the SW when we have one.
        if (swReg && swReg.showNotification) {
          swReg.showNotification(copy.title, opts).catch((e) => console.error("Notification failed:", e));
        } else {
          new Notification(copy.title, opts);
        }
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
    const hint = $("iosHint");
    if (!btn || !stateEl) return;
    if (!("Notification" in window)) {
      btn.hidden = true;
      stateEl.hidden = false;
      stateEl.textContent = "Not on this browser";
      if (hint) hint.hidden = !(isIos() && !isStandalone());
      return;
    }
    const p = Notification.permission;
    if (p === "granted") {
      btn.hidden = true;
      stateEl.hidden = false;
      stateEl.textContent = "On";
      stateEl.classList.add("linked");
      if (hint) hint.hidden = true;
    } else if (p === "denied") {
      btn.hidden = true;
      stateEl.hidden = false;
      stateEl.textContent = "Blocked in browser";
      stateEl.classList.remove("linked");
      if (hint) hint.hidden = true;
    } else {
      btn.hidden = false;
      stateEl.hidden = true;
      if (hint) hint.hidden = !(isIos() && !isStandalone());
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
    // Self-heal: if permission is already granted but the server lost the
    // subscription (cleared data, expired endpoint), quietly resubscribe.
    // Throttled so a permanently failing browser doesn't retry every poll.
    if (
      channels &&
      !channels.push &&
      "Notification" in window &&
      Notification.permission === "granted" &&
      Date.now() - lastPushAttempt > 60000
    ) {
      lastPushAttempt = Date.now();
      subscribeToPush();
    }
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

  function applyPhase(phase, channels) {
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

    // Server push already alerts the device; skip in-tab ping to avoid doubles.
    const skipLocalPing = !!(channels && channels.push);

    if (phase === "almost" && lastPhase !== "almost" && !skipLocalPing) {
      $("advancePanel").classList.add("pulse-once");
      setTimeout(() => $("advancePanel").classList.remove("pulse-once"), 2000);
      pingDevice("almost");
    }
    if (phase === "yourTurn" && lastPhase !== "yourTurn" && !skipLocalPing) {
      $("turnPanel").classList.add("pulse-once");
      setTimeout(() => $("turnPanel").classList.remove("pulse-once"), 2000);
      pingDevice("yourTurn");
    }

    document.title = phase === "yourTurn" ? "YOUR TURN | Maroon" : baseTitle;
    $("notifyCard").hidden = phase === "inStore" || phase === "done";
    lastPhase = phase;
    storePhase(phase);
  }

  async function loadConfig() {
    try {
      const cfg = await request("/api/config", { retries: 2 });
      queueOpen = cfg.open;
      botUsername = cfg.botUsername || "";
      emailEnabled = !!cfg.emailEnabled;
      vapidPublicKey = cfg.vapidPublicKey || "";
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
    lastPhase = loadStoredPhase();
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
    const phone = ($("phone").value || "").trim();
    if (!phone) {
      $("joinError").textContent = "Drop your handphone number so we can reach you.";
      return;
    }
    if (!/^\+?[\d\s-()]{8,20}$/.test(phone)) {
      $("joinError").textContent = "That handphone number doesn't look right. Give it another go!";
      return;
    }
    const email = emailEnabled ? ($("joinEmail").value || "").trim().toLowerCase() : "";
    if (emailEnabled) {
      if (!email) {
        $("joinError").textContent = "Drop your email so we can reach you when it's time.";
        return;
      }
      if (!/^\S+@\S+\.\S+$/.test(email)) {
        $("joinError").textContent = "That email doesn't look right. Give it another go!";
        return;
      }
    }
    setLoading($("joinBtn"), true);
    try {
      const j = await request("/api/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(emailEnabled ? { name, phone, email } : { name, phone }),
      });
      token = j.token;
      localStorage.setItem("maroonToken", token);
      lastPhase = loadStoredPhase();
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

      applyPhase(s.phase, s.channels);
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
    if (!val) {
      $("emailMsg").textContent = "We need your email to ping you when it's time.";
      return;
    }
    if (!/^\S+@\S+\.\S+$/.test(val.toLowerCase())) {
      $("emailMsg").textContent = "That email doesn't look right. Give it another go!";
      return;
    }
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
        : "";
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
      if ("Notification" in window) {
        const perm = await Notification.requestPermission();
        if (perm === "granted") await subscribeToPush();
      }
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
