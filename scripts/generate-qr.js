#!/usr/bin/env node
/**
 * Generate a printable QR code SVG for the guest join page.
 * Usage: PUBLIC_URL=https://your-app.vercel.app npm run qr
 */
require("./load-env").loadEnvFiles();

const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode");

const base = (process.env.PUBLIC_URL || "http://localhost:3000").replace(/\/$/, "");
const url = base + "/";
const outDir = path.join(__dirname, "..", "public", "assets");
const outFile = path.join(outDir, "queue-qr.svg");

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const svg = await QRCode.toString(url, {
    type: "svg",
    margin: 2,
    width: 512,
    color: { dark: "#6a1f2a", light: "#ffffff" },
  });
  fs.writeFileSync(outFile, svg, "utf8");
  console.log("Guest join URL:", url);
  console.log("Wrote", outFile);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
