/*
 * Sends one test email using the same SMTP env vars as server.js, so you
 * can check a Gmail (or any SMTP) setup before opening the queue.
 *
 * Usage: npm run test-email -- you@example.com
 */

require("./load-env").loadEnvFiles();

const { createSmtpTransport, smtpCertHint, smtpAuthHint } = require("./smtp-transport");

const to = process.argv[2];
if (!to) {
  console.error("Usage: npm run test-email -- you@example.com");
  process.exit(1);
}

const { SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;

if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
  console.error("Set SMTP_HOST, SMTP_USER and SMTP_PASS first. See .env.example for the Gmail example.");
  process.exit(1);
}

const transport = createSmtpTransport();
console.log(`Sending test email via ${SMTP_HOST} as ${SMTP_USER} ...`);

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
    console.error("Send failed:", e.message + smtpCertHint(e) + smtpAuthHint(e));
    process.exit(1);
  });
