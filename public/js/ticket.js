/**
 * The Maroon Ticket. Renders a shareable, story-sized queue ticket on a
 * canvas and wires up the save / share buttons on the status card.
 * Exposed as window.MaroonTicket so guest.js can call render() from its
 * status poll. Golden rule: every queue number divisible by 25 is a
 * golden ticket and wins a little surprise at the door.
 */
(function (global) {
  const W = 1080;
  const H = 1350;

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");

  let lastKey = null;
  let currentNumber = null;
  let currentGolden = false;

  /* ----- palette: pulled from style.css :root, with safe fallbacks ----- */
  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim();
    return v || fallback;
  }

  function palette(golden) {
    if (golden) {
      return {
        page: "#14100a",
        panelTop: "#2a2008",
        panelBottom: "#171106",
        edge: "#d9b64a",
        edgeSoft: "rgba(217, 182, 74, 0.4)",
        headline: "#f4df9a",
        accent: "#d9b64a",
        body: "#e9dcb4",
        dim: "rgba(233, 220, 180, 0.7)",
        number: "#f7e7ae",
        glow: "rgba(217, 182, 74, 0.55)",
      };
    }
    const ink = cssVar("--ink", "#270707");
    const ink2 = cssVar("--ink-2", "#1c0505");
    const maroon = cssVar("--maroon", "#660810");
    const maroonBright = cssVar("--maroon-bright", "#8a1220");
    const cream = cssVar("--cream", "#f1ebeb");
    const sand = cssVar("--sand", "#d6c0b1");
    return {
      page: ink2,
      panelTop: maroon,
      panelBottom: ink,
      edge: sand,
      edgeSoft: "rgba(214, 192, 177, 0.35)",
      headline: cream,
      accent: sand,
      body: cream,
      dim: "rgba(241, 235, 235, 0.65)",
      number: cream,
      glow: maroonBright,
    };
  }

  /* ----- badge image: draw with it if it loads, without it if not ----- */
  const badge = { img: null, settled: false };
  const badgePromise = new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      badge.img = img;
      badge.settled = true;
      resolve();
    };
    img.onerror = () => {
      badge.settled = true;
      resolve();
    };
    img.src = "assets/badge-oval.png";
  });

  /* ----- text helpers: condensed Times, tracked uppercase ----- */
  function font(size, style) {
    return (style ? style + " " : "") + size + 'px "Times New Roman", Times, serif';
  }

  function drawTracked(text, cx, y, size, color, tracking, style) {
    ctx.font = font(size, style);
    ctx.fillStyle = color;
    const chars = String(text).split("");
    let total = 0;
    for (const ch of chars) total += ctx.measureText(ch).width + tracking;
    total -= tracking;
    let x = cx - total / 2;
    for (const ch of chars) {
      ctx.fillText(ch, x, y);
      x += ctx.measureText(ch).width + tracking;
    }
  }

  function drawCondensed(text, cx, y, size, color, squeeze, style) {
    ctx.save();
    ctx.translate(cx, y);
    ctx.scale(squeeze, 1);
    ctx.font = font(size, style);
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.fillText(text, 0, 0);
    ctx.restore();
    ctx.textAlign = "left";
  }

  /* ----- the ticket itself ----- */
  function drawTicket(number, name, golden) {
    const p = palette(golden);
    const M = 52; // page margin around the ticket body
    const NOTCH = 34; // perforation notch radius
    const stubY = 1010; // where the stub tears off

    ctx.clearRect(0, 0, W, H);

    // page behind the ticket
    ctx.fillStyle = p.page;
    ctx.fillRect(0, 0, W, H);

    // ticket body
    const grad = ctx.createLinearGradient(0, M, 0, H - M);
    grad.addColorStop(0, p.panelTop);
    grad.addColorStop(1, p.panelBottom);
    ctx.fillStyle = grad;
    roundRect(M, M, W - M * 2, H - M * 2, 18);
    ctx.fill();

    // soft glow behind the top half
    const glow = ctx.createRadialGradient(W / 2, 320, 60, W / 2, 320, 620);
    glow.addColorStop(0, golden ? "rgba(217, 182, 74, 0.28)" : "rgba(138, 18, 32, 0.5)");
    glow.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(M, M, W - M * 2, stubY - M);

    // border
    ctx.strokeStyle = p.edgeSoft;
    ctx.lineWidth = 3;
    roundRect(M + 10, M + 10, W - (M + 10) * 2, H - (M + 10) * 2, 12);
    ctx.stroke();

    // perforation notches punched out of the sides
    ctx.fillStyle = p.page;
    ctx.beginPath();
    ctx.arc(M, stubY, NOTCH, 0, Math.PI * 2);
    ctx.arc(W - M, stubY, NOTCH, 0, Math.PI * 2);
    ctx.fill();

    // dashed tear line between the notches
    ctx.strokeStyle = p.edgeSoft;
    ctx.lineWidth = 3;
    ctx.setLineDash([16, 14]);
    ctx.beginPath();
    ctx.moveTo(M + NOTCH + 14, stubY);
    ctx.lineTo(W - M - NOTCH - 14, stubY);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";

    // oval badge up top, if it loaded
    let topY; // baseline of the eyebrow line
    if (badge.img) {
      const bw = 210;
      const bh = bw * (badge.img.naturalHeight / badge.img.naturalWidth);
      ctx.save();
      ctx.globalAlpha = golden ? 0.95 : 0.92;
      ctx.drawImage(badge.img, W / 2 - bw / 2, 116, bw, bh);
      ctx.restore();
      topY = 116 + bh + 64;
    } else {
      topY = 260;
    }

    // eyebrow
    ctx.textAlign = "left";
    drawTracked(
      golden ? "GOLDEN TICKET" : "POP-UP WEEKEND",
      W / 2,
      topY,
      30,
      p.accent,
      12
    );

    // headline
    drawCondensed("PAINT THE TOWN", W / 2, topY + 86, 96, p.headline, 0.82);
    drawCondensed("MAROON", W / 2, topY + 178, 96, golden ? p.accent : p.headline, 0.82);

    // thin rule
    ctx.strokeStyle = p.edgeSoft;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(W / 2 - 70, topY + 218);
    ctx.lineTo(W / 2 + 70, topY + 218);
    ctx.stroke();

    // the number, huge
    ctx.textAlign = "left";
    drawTracked("YOUR NUMBER", W / 2, topY + 274, 26, p.dim, 10);
    ctx.save();
    ctx.shadowColor = p.glow;
    ctx.shadowBlur = 60;
    drawCondensed(String(number), W / 2, topY + 548, 310, p.number, 0.88);
    ctx.restore();

    // guest name, shrunk to fit if it's a long one
    const shownName = (name || "").trim() || "A friend of Maroon";
    let nameSize = 48;
    ctx.font = font(nameSize, "italic");
    const maxNameWidth = W - M * 2 - 120;
    const nameWidth = ctx.measureText(shownName).width * 0.92;
    if (nameWidth > maxNameWidth) nameSize = Math.max(26, Math.floor(nameSize * (maxNameWidth / nameWidth)));
    drawCondensed(shownName, W / 2, topY + 614, nameSize, p.body, 0.92, "italic");

    // stub
    ctx.textAlign = "left";
    drawTracked("11 & 12 JULY", W / 2, stubY + 78, 34, p.headline, 8);
    drawTracked("MANDARIN GALLERY #02-19", W / 2, stubY + 130, 26, p.dim, 8);
    if (golden) {
      drawCondensed(
        "Every 25th in line wins. Show this at the door.",
        W / 2,
        stubY + 194,
        38,
        p.accent,
        0.92,
        "italic"
      );
    } else {
      drawCondensed(
        "First come, first served. Wear the town.",
        W / 2,
        stubY + 194,
        38,
        p.dim,
        0.92,
        "italic"
      );
    }
    drawTracked("MAROON.CLOTHING", W / 2, stubY + 252, 22, p.dim, 10);
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ----- DOM wiring ----- */
  const $ = (id) => document.getElementById(id);

  function fileName() {
    return "maroon-ticket-" + currentNumber + ".png";
  }

  function toBlob() {
    return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  }

  function download(blob) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = fileName();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  async function saveTicket() {
    if (currentNumber == null) return;
    const blob = await toBlob();
    if (blob) download(blob);
  }

  async function shareTicket() {
    if (currentNumber == null) return;
    const blob = await toBlob();
    if (!blob) return;
    const file = new File([blob], fileName(), { type: "image/png" });
    const shareData = {
      files: [file],
      title: "Paint the Town Maroon",
      text: currentGolden
        ? "Golden ticket at the Maroon pop-up. Every 25th in line wins. 11 & 12 July, Mandarin Gallery #02-19."
        : "In line at Paint the Town Maroon. 11 & 12 July, Mandarin Gallery #02-19. Pull up.",
    };
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share(shareData);
        return;
      } catch (err) {
        if (err && err.name === "AbortError") return; // user closed the sheet
      }
    }
    download(blob);
  }

  function updateDom(golden) {
    const section = $("ticketSection");
    if (!section) return;
    section.hidden = false;
    section.classList.toggle("gold", golden);

    const title = $("ticketTitle");
    if (title)
      title.textContent = golden ? "You struck gold" : "Your Maroon Ticket";

    const caption = $("ticketCaption");
    if (caption)
      caption.textContent = golden
        ? "Every 25th number in line wins. Show this ticket at the door for a little surprise from Maroon. Then post it to your story, because come on."
        : "Save it, post it to your story, tag @maroon.clothing. Let the town know you pulled up.";

    const preview = $("ticketPreview");
    if (preview) {
      preview.src = canvas.toDataURL("image/png");
      preview.alt = golden
        ? "Golden Maroon queue ticket number " + currentNumber
        : "Maroon queue ticket number " + currentNumber;
    }
  }

  /**
   * Called by guest.js on every status poll. Re-renders only when the
   * number, name, or golden state actually changes.
   */
  function render(number, name, isGolden) {
    if (typeof number !== "number" || !isFinite(number)) return;
    const golden = !!isGolden;
    const key = number + "|" + (name || "") + "|" + golden;
    if (key === lastKey) return;
    lastKey = key;
    currentNumber = number;
    currentGolden = golden;
    badgePromise.then(() => {
      drawTicket(number, name, golden);
      updateDom(golden);
    });
  }

  function hide() {
    const section = $("ticketSection");
    if (section) section.hidden = true;
    lastKey = null;
    currentNumber = null;
  }

  $("ticketSaveBtn")?.addEventListener("click", saveTicket);
  $("ticketShareBtn")?.addEventListener("click", shareTicket);

  global.MaroonTicket = { render, hide };
})(window);
