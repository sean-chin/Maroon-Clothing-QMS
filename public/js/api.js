/**
 * Shared fetch helper with retries, backoff, and graceful JSON parsing.
 */
(function (global) {
  const DEFAULT_RETRIES = 3;
  const BASE_DELAY_MS = 800;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function request(path, opts = {}) {
    const { retries = DEFAULT_RETRIES, ...fetchOpts } = opts;
    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(path, fetchOpts);
        let body = {};
        try {
          body = await res.json();
        } catch {
          body = {};
        }
        if (!res.ok) {
          const err = new Error(body.error || `Request failed (${res.status})`);
          err.status = res.status;
          err.body = body;
          throw err;
        }
        return body;
      } catch (err) {
        lastError = err;
        if (err.status === 401 || err.status === 403 || err.status === 404) throw err;
        if (attempt < retries) await sleep(BASE_DELAY_MS * (attempt + 1));
      }
    }
    throw lastError || new Error("Network error");
  }

  function showFatal(message) {
    const el = document.getElementById("fatalError");
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
  }

  global.addEventListener("error", (e) => {
    console.error(e.error || e.message);
    showFatal("Something went wrong. Please refresh the page.");
  });
  global.addEventListener("unhandledrejection", (e) => {
    console.error(e.reason);
  });

  global.MaroonAPI = { request, sleep };
})(window);
