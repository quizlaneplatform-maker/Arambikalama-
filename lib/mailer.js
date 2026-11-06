// Sends email for login codes. Three ways, tried in this order:
//   1. BREVO_API_KEY set  -> Brevo's HTTPS API (port 443). Use this on hosts that block SMTP ports,
//                            e.g. Render's free web services block 25, 465 and 587.
//   2. SMTP_* set         -> SMTP (e.g. Gmail with an App Password).
//   3. neither            -> printed to the server console (local development).
const nodemailer = require("nodemailer");

const SEND_TIMEOUT_MS = 15_000; // fail fast instead of leaving "Sending code…" hanging for minutes

const brevoConfigured = () => Boolean(process.env.BREVO_API_KEY);
const smtpConfigured = () => Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
const configured = () => brevoConfigured() || smtpConfigured();

/** "Aarambikallama <me@gmail.com>" -> { name, email } */
function parseFrom(from) {
  const m = /^\s*(.*?)\s*<\s*([^>\s]+)\s*>\s*$/.exec(from || "");
  if (m) return { name: m[1].replace(/^"|"$/g, "") || undefined, email: m[2] };
  return { email: (from || "").trim() };
}
const sender = () => parseFrom(process.env.MAIL_FROM || process.env.SMTP_USER || "");

// ---- Brevo (HTTPS)
async function brevo(path, init = {}) {
  const res = await fetch(`https://api.brevo.com/v3${path}`, {
    ...init,
    headers: { "api-key": process.env.BREVO_API_KEY.trim(), accept: "application/json", "content-type": "application/json", ...init.headers },
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Brevo ${res.status}: ${body.message || body.code || res.statusText}`);
  return body;
}

async function sendViaBrevo({ to, subject, text, html }) {
  const from = sender();
  if (!from.email) throw new Error("Set MAIL_FROM to the sender address you verified in Brevo.");
  await brevo("/smtp/email", {
    method: "POST",
    body: JSON.stringify({ sender: from, to: [{ email: to }], subject, textContent: text, htmlContent: html }),
  });
}

// ---- SMTP
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
      connectionTimeout: SEND_TIMEOUT_MS,
      greetingTimeout: SEND_TIMEOUT_MS,
      socketTimeout: SEND_TIMEOUT_MS,
    });
  }
  return transport;
}

/** @returns {Promise<"email" | "console">} where the message went */
async function sendMail({ to, subject, text, html }) {
  if (brevoConfigured()) {
    await sendViaBrevo({ to, subject, text, html });
    return "email";
  }
  if (smtpConfigured()) {
    await getTransport().sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, text, html });
    return "email";
  }
  console.log(`\n[mail not configured: set BREVO_API_KEY or SMTP_* in .env] To: ${to}\nSubject: ${subject}\n${text}\n`);
  return "console";
}

/** In production, login codes must really be emailed (not printed to logs). */
function assertMailForProduction() {
  if (process.env.NODE_ENV !== "production" || configured() || process.env.ALLOW_CONSOLE_OTP === "true") return;
  console.error("Refusing to start: NODE_ENV=production but no email is set up, so teachers could not receive login codes.\n" +
    "Set BREVO_API_KEY + MAIL_FROM, or SMTP_HOST/SMTP_USER/SMTP_PASS (see DEPLOYMENT.md), or ALLOW_CONSOLE_OTP=true for a private demo.");
  process.exit(1);
}

/** Log at startup whether email works, so a bad key or blocked port shows up before a teacher tries to log in. */
async function checkMail() {
  if (brevoConfigured()) {
    try {
      const acct = await brevo("/account");
      console.log(`  Login codes: emailed via Brevo (account ${acct.email || "ok"}) from ${sender().email || "MAIL_FROM not set!"}`);
    } catch (e) {
      console.log(`  Login codes: EMAIL NOT WORKING (${e.message}). Check BREVO_API_KEY.`);
    }
    return;
  }
  if (!smtpConfigured()) return console.log("  Login codes: printed in this console (set BREVO_API_KEY or SMTP_* in .env to email them)");
  try {
    await getTransport().verify();
    console.log(`  Login codes: emailed via ${process.env.SMTP_HOST} as ${process.env.SMTP_USER}`);
  } catch (e) {
    const blocked = /timeout|ETIMEDOUT|ECONNREFUSED|ENETUNREACH/i.test(`${e.code} ${e.message}`);
    console.log(`  Login codes: EMAIL NOT WORKING (${e.message}).` + (blocked
      ? " This host may block SMTP ports (Render's free plan does). Set BREVO_API_KEY to send over HTTPS instead."
      : " Check SMTP_* in .env."));
  }
}

module.exports = { sendMail, mailConfigured: configured, checkMail, assertMailForProduction };
