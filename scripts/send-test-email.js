/*
 * Sends one test email using the same SMTP env vars as server.js, so you
 * can check a Gmail (or any SMTP) setup before opening the queue.
 *
 * Usage: SMTP_HOST=... SMTP_USER=... SMTP_PASS=... npm run test-email -- you@example.com
 */

const nodemailer = require("nodemailer");

const to = process.argv[2];
if (!to) {
  console.error("Usage: npm run test-email -- you@example.com");
  process.exit(1);
}

const { SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587", 10);

if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
  console.error("Set SMTP_HOST, SMTP_USER and SMTP_PASS first. See .env.example for the Gmail example.");
  process.exit(1);
}

const transport = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465,
  auth: { user: SMTP_USER, pass: SMTP_PASS },
});

transport
  .sendMail({
    from: `"Maroon Clothing" <${SMTP_FROM || SMTP_USER}>`,
    to,
    subject: "Maroon test email, you're all set",
    text: "If this landed in your inbox, SMTP is wired up correctly. Time to open the queue.",
  })
  .then(() => {
    console.log(`Test email sent to ${to}. Go check the inbox (and the spam folder, just in case).`);
  })
  .catch((e) => {
    console.error("Send failed:", e.message);
    process.exit(1);
  });
