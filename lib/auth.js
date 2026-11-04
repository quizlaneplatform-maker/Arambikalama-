// Teacher accounts with passwordless email login (like food-delivery / social apps):
// enter email -> receive a 6-digit code -> verified = logged in. New emails are asked for a name once.
// Cookie sessions are persisted to disk.
const crypto = require("crypto");
const express = require("express");
const { file, readJson, writeJson, newId } = require("./store");
const { sendMail } = require("./mailer");

const USERS_FILE = file("users.json");
const SESSIONS_FILE = file("sessions.json");
const COOKIE = "ql_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const OTP_TTL_MS = 10 * 60 * 1000; // a code is valid for 10 minutes
const OTP_MAX_ATTEMPTS = 5; // wrong guesses per code
const OTP_RESEND_COOLDOWN_MS = 30 * 1000; // "Resend OTP in 0:30"
const OTP_MAX_SENDS = 5; // codes per login attempt
const EMAIL_MAX_FAILS = 10; // wrong guesses per email across attempts...
const EMAIL_LOCK_MS = 15 * 60 * 1000; // ...before a 15-minute lock
const IP_MAX_STARTS = 20; // new logins per IP per 15 min (stops email-bombing)
const SIGNUP_TTL_MS = 15 * 60 * 1000; // time to enter a name after verifying a new email

let users = readJson(USERS_FILE, []);
let sessions = readJson(SESSIONS_FILE, {}); // sha256(token) -> { userId, expires }
const challenges = new Map(); // challengeId -> { email, codeHash, expires, attempts, sends, lastSentAt }
const signups = new Map(); // sha256(signupToken) -> { email, expires }
const emailFails = new Map(); // email -> { count, until }
const emailLastSent = new Map(); // email -> timestamp (cooldown even across new challenges)
const ipStarts = new Map(); // ip -> timestamps

const saveUsers = () => writeJson(USERS_FILE, users);
const saveSessions = () => writeJson(SESSIONS_FILE, sessions);
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const cleanEmail = (v) => String(v ?? "").trim().toLowerCase().slice(0, 200);
const maskEmail = (e) => e.replace(/^(.{1,2})[^@]*(@.*)$/, (_, a, b) => `${a}***${b}`);
const otpHash = (challengeId, code) => sha256(`${challengeId}:${code}`);
const emailLocked = (email) => { const f = emailFails.get(email); return f && f.count >= EMAIL_MAX_FAILS && f.until > Date.now(); };
const userByEmail = (email) => users.find((u) => u.email === email);

function sweep() {
  const now = Date.now();
  for (const [k, c] of challenges) if (c.expires < now && c.lastSentAt + OTP_TTL_MS < now) challenges.delete(k);
  for (const [k, s] of signups) if (s.expires < now) signups.delete(k);
  for (const [k, t] of emailLastSent) if (t + OTP_TTL_MS < now) emailLastSent.delete(k);
}

async function sendCode(challengeId, ch) {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  ch.codeHash = otpHash(challengeId, code);
  ch.expires = Date.now() + OTP_TTL_MS;
  ch.attempts = 0;
  ch.sends += 1;
  ch.lastSentAt = Date.now();
  emailLastSent.set(ch.email, ch.lastSentAt);
  const name = userByEmail(ch.email)?.name;
  const greeting = name ? `Hi ${name},` : "Hi,";
  return sendMail({
    to: ch.email,
    subject: `${code} is your Aarambikallama login code`,
    text: `${greeting}\n\nYour Aarambikallama login code is: ${code}\n\nIt expires in 10 minutes. Never share this code with anyone. If you didn't try to log in, you can ignore this email.`,
    html: `<div style="font-family:system-ui,sans-serif;max-width:420px;margin:auto;padding:24px;border:1px solid #e6e5f0;border-radius:16px">
      <h2 style="margin:0 0 8px;color:#ff319f">Aarambikallama</h2>
      <p>${greeting.replace(/[<>&"]/g, "")} here is your login code:</p>
      <p style="font-size:34px;font-weight:800;letter-spacing:10px;margin:16px 0">${code}</p>
      <p style="color:#6a6884">It expires in 10 minutes. Never share this code with anyone. If you didn't try to log in, ignore this email.</p></div>`,
  });
}

function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Resolve the logged-in teacher from a raw Cookie header (works for HTTP and Socket.IO). */
function userFromCookieHeader(header) {
  const token = parseCookies(header)[COOKIE];
  if (!token) return null;
  const session = sessions[sha256(token)];
  if (!session || session.expires < Date.now()) return null;
  return users.find((u) => u.id === session.userId) || null;
}

function startSession(req, res, userId) {
  const now = Date.now();
  for (const [k, s] of Object.entries(sessions)) if (s.expires < now) delete sessions[k];
  const token = crypto.randomBytes(32).toString("base64url");
  sessions[sha256(token)] = { userId, expires: now + SESSION_TTL_MS };
  saveSessions();
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${req.secure ? "; Secure" : ""}`,
  );
}

function requireTeacher(req, res, next) {
  const user = userFromCookieHeader(req.headers.cookie);
  if (!user) return res.status(401).json({ error: "Please log in." });
  req.user = user;
  next();
}

/** @param {{ onSignup?: (user, isFirstUser: boolean) => void, aiEnabled: () => boolean }} hooks */
function authRouter(hooks) {
  const router = express.Router();

  // Step 1: email -> send code. The response is identical for new and existing emails,
  // so nobody can use this to find out who has an account.
  router.post("/otp/start", async (req, res) => {
    sweep();
    const email = cleanEmail(req.body?.email);
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "Enter a valid email address." });
    if (emailLocked(email)) return res.status(429).json({ error: "Too many wrong codes. Try again in 15 minutes." });

    const wait = (emailLastSent.get(email) ?? 0) + OTP_RESEND_COOLDOWN_MS - Date.now();
    if (wait > 0) return res.status(429).json({ error: `We just sent a code. Try again in ${Math.ceil(wait / 1000)}s.`, retryAfter: Math.ceil(wait / 1000) });

    const hour = Date.now() - EMAIL_LOCK_MS;
    const recent = (ipStarts.get(req.ip) || []).filter((t) => t > hour);
    if (recent.length >= IP_MAX_STARTS) return res.status(429).json({ error: "Too many login attempts from this network. Try again later." });
    ipStarts.set(req.ip, [...recent, Date.now()]);

    const challengeId = crypto.randomBytes(24).toString("base64url");
    const ch = { email, codeHash: "", expires: 0, attempts: 0, sends: 0, lastSentAt: 0 };
    challenges.set(challengeId, ch);
    try {
      const via = await sendCode(challengeId, ch);
      res.json({ challenge: challengeId, email: maskEmail(email), resendIn: OTP_RESEND_COOLDOWN_MS / 1000, devConsole: via === "console" });
    } catch (e) {
      challenges.delete(challengeId);
      emailLastSent.delete(email);
      console.error("Sending login code failed:", e.message);
      res.status(502).json({ error: "We couldn't send the email right now. Try again in a minute." });
    }
  });

  router.post("/otp/resend", async (req, res) => {
    const challengeId = String(req.body?.challenge ?? "");
    const ch = challenges.get(challengeId);
    if (!ch) return res.status(400).json({ error: "This login has expired. Enter your email again.", restart: true });
    const wait = ch.lastSentAt + OTP_RESEND_COOLDOWN_MS - Date.now();
    if (wait > 0) return res.status(429).json({ error: `Wait ${Math.ceil(wait / 1000)}s before resending.`, retryAfter: Math.ceil(wait / 1000) });
    if (ch.sends >= OTP_MAX_SENDS) return res.status(429).json({ error: "Too many codes sent. Try again later.", restart: true });
    try {
      const via = await sendCode(challengeId, ch);
      res.json({ ok: true, resendIn: OTP_RESEND_COOLDOWN_MS / 1000, devConsole: via === "console" });
    } catch (e) {
      console.error("Resending login code failed:", e.message);
      res.status(502).json({ error: "We couldn't send the email right now. Try again." });
    }
  });

  // Step 2: code -> logged in (existing teacher) or asked for a name (new teacher).
  router.post("/otp/verify", (req, res) => {
    const challengeId = String(req.body?.challenge ?? "");
    const code = String(req.body?.code ?? "").replace(/\D/g, "");
    const ch = challenges.get(challengeId);
    if (!ch) return res.status(400).json({ error: "This code has expired. Enter your email again.", restart: true });
    if (emailLocked(ch.email)) return res.status(429).json({ error: "Too many wrong codes. Try again in 15 minutes.", restart: true });
    if (ch.expires < Date.now()) return res.status(400).json({ error: "This code has expired. Tap “Resend OTP”." });
    if (ch.attempts >= OTP_MAX_ATTEMPTS) return res.status(429).json({ error: "Too many wrong codes. Tap “Resend OTP”." });
    ch.attempts += 1;
    const ok = code.length === 6 && crypto.timingSafeEqual(Buffer.from(otpHash(challengeId, code)), Buffer.from(ch.codeHash));
    if (!ok) {
      const f = emailFails.get(ch.email);
      emailFails.set(ch.email, { count: f && f.until > Date.now() ? f.count + 1 : 1, until: Date.now() + EMAIL_LOCK_MS });
      const left = OTP_MAX_ATTEMPTS - ch.attempts;
      return res.status(401).json({ error: left > 0 ? `Incorrect OTP. ${left} attempt${left === 1 ? "" : "s"} left.` : "Too many wrong codes. Tap “Resend OTP”." });
    }
    challenges.delete(challengeId);
    emailFails.delete(ch.email);
    emailLastSent.delete(ch.email);

    const user = userByEmail(ch.email);
    if (user) {
      startSession(req, res, user.id);
      return res.json({ user: publicUser(user), aiEnabled: hooks.aiEnabled() });
    }
    const signupToken = crypto.randomBytes(24).toString("base64url");
    signups.set(sha256(signupToken), { email: ch.email, expires: Date.now() + SIGNUP_TTL_MS });
    res.json({ needName: true, signupToken });
  });

  // Step 3 (first time only): name -> account created and logged in.
  router.post("/otp/complete", (req, res) => {
    const key = sha256(String(req.body?.signupToken ?? ""));
    const pending = signups.get(key);
    if (!pending || pending.expires < Date.now()) return res.status(400).json({ error: "This sign-up has expired. Enter your email again.", restart: true });
    const name = String(req.body?.name ?? "").trim().replace(/\s+/g, " ").slice(0, 60);
    if (!name) return res.status(400).json({ error: "Enter your name." });
    signups.delete(key);
    let user = userByEmail(pending.email); // created meanwhile in another tab?
    if (!user) {
      user = { id: newId(), name, email: pending.email, createdAt: Date.now() };
      const isFirstUser = users.length === 0;
      users.push(user);
      saveUsers();
      hooks.onSignup?.(user, isFirstUser);
    }
    startSession(req, res, user.id);
    res.status(201).json({ user: publicUser(user), aiEnabled: hooks.aiEnabled() });
  });

  router.post("/logout", (req, res) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token && sessions[sha256(token)]) {
      delete sessions[sha256(token)];
      saveSessions();
    }
    res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    res.status(204).end();
  });

  router.get("/me", requireTeacher, (req, res) => res.json({ user: publicUser(req.user), aiEnabled: hooks.aiEnabled() }));

  return router;
}

module.exports = { authRouter, requireTeacher, userFromCookieHeader };
