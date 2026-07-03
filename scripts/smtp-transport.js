/**
 * Shared nodemailer transport options for server.js and send-test-email.js.
 */
const nodemailer = require("nodemailer");

function smtpTlsInsecure() {
  const v = String(process.env.SMTP_TLS_INSECURE || "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

// Gmail shows app passwords in 4 groups; nodemailer accepts either form.
function normalizeSmtpPass(pass, host) {
  const p = String(pass || "");
  if (/gmail\.com|googlemail\.com/i.test(host)) return p.replace(/\s+/g, "");
  return p;
}

function smtpTransportOptions() {
  const host = process.env.SMTP_HOST || "";
  const port = parseInt(process.env.SMTP_PORT || "587", 10);
  const user = String(process.env.SMTP_USER || "").trim();
  const pass = normalizeSmtpPass(process.env.SMTP_PASS, host);
  const opts = {
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  };
  if (smtpTlsInsecure()) {
    opts.tls = { rejectUnauthorized: false };
  }
  return opts;
}

function createSmtpTransport() {
  return nodemailer.createTransport(smtpTransportOptions());
}

function smtpCertHint(err) {
  const msg = err && err.message ? err.message : "";
  if (/self-signed certificate|certificate chain|UNABLE_TO_VERIFY_LEAF_SIGNATURE/i.test(msg)) {
    return " Add SMTP_TLS_INSECURE=1 to .env.local if antivirus or a proxy is inspecting TLS (common on Windows).";
  }
  return "";
}

function smtpAuthHint(err) {
  const msg = err && err.message ? err.message : "";
  if (!/535|BadCredentials|Username and Password not accepted|Invalid login/i.test(msg)) return "";
  return [
    "",
    "Gmail rejected the login. This is almost always a bad or revoked app password, not a code bug.",
    "1. Sign in to maroonclothingbrand@gmail.com (the same address as SMTP_USER).",
    "2. Turn on 2-Step Verification if it is off: https://myaccount.google.com/signinoptions/two-step-verification",
    "3. Create a new app password (Mail): https://myaccount.google.com/apppasswords",
    "4. Put the 16-character password in SMTP_PASS in .env.local (spaces are fine).",
    "5. If deployed on Vercel, update SMTP_PASS there too, then redeploy.",
    "Do not use your normal Gmail password — only an app password works for SMTP.",
  ].join("\n");
}

module.exports = {
  createSmtpTransport,
  smtpTransportOptions,
  smtpTlsInsecure,
  smtpCertHint,
  smtpAuthHint,
};
