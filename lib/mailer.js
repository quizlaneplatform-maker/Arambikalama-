// Sends email over SMTP (e.g. Gmail with an App Password). Without SMTP settings it logs the
// message to the server console instead, so the app still works during local development.
const nodemailer = require("nodemailer");

const configured = () => Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

let transport = null;
function getTransport() {
  if (!transport) {
    const port = Number(process.env.SMTP_PORT) || 465;
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465, // 465 = implicit TLS; 587 upgrades with STARTTLS
      // Google shows app passwords as "abcd efgh ijkl mnop"; the spaces aren't part of it.
      auth: { user: process.env.SMTP_USER.trim(), pass: process.env.SMTP_PASS.replace(/\s+/g, "") },
    });
  }
  return transport;
}

/** @returns {Promise<"email" | "console">} where the message went */
async function sendMail({ to, subject, text, html }) {
  if (!configured()) {
    console.log(`\n[mail not configured: set SMTP_* in .env] To: ${to}\nSubject: ${subject}\n${text}\n`);
    return "console";
  }
  await getTransport().sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, text, html });
  return "email";
}

/** In production, login codes must really be emailed (not printed to logs). */
function assertMailForProduction() {
  if (process.env.NODE_ENV !== "production" || configured() || process.env.ALLOW_CONSOLE_OTP === "true") return;
  console.error("Refusing to start: NODE_ENV=production but SMTP_* is not set, so teachers could not receive login codes.\n" +
    "Set SMTP_HOST, SMTP_USER, SMTP_PASS (see DEPLOYMENT.md), or set ALLOW_CONSOLE_OTP=true for a private demo.");
  process.exit(1);
}

/** Log at startup whether email works, so a wrong password shows up before a teacher tries to log in. */
async function checkMail() {
  if (!configured()) return console.log("  Login codes: printed in this console (set SMTP_* in .env to email them)");
  try {
    await getTransport().verify();
    console.log(`  Login codes: emailed via ${process.env.SMTP_HOST} as ${process.env.SMTP_USER}`);
  } catch (e) {
    console.log(`  Login codes: EMAIL NOT WORKING (${e.message}). Check SMTP_* in .env.`);
  }
}

module.exports = { sendMail, mailConfigured: configured, checkMail, assertMailForProduction };
