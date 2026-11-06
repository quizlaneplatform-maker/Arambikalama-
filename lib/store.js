// Persistence for users, sessions, quizzes and reports.
// The app keeps everything in memory; each "file" (users.json, quizzes.json, ...) is saved as a whole.
//
// Two backends:
//   DATABASE_URL set -> Postgres (e.g. a free Neon database). Each file is one row in the app_data
//                       table. Everything is loaded once at startup (init); saves run in the
//                       background, in order, and are retried if the database is unreachable.
//   otherwise        -> JSON files in DATA_DIR (or ./data).
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const LOCAL_DIR = path.join(__dirname, "..", "data");
const WANTED_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : LOCAL_DIR;
const usePostgres = () => Boolean(process.env.DATABASE_URL);

// ---------------------------------------------------------------- files
/** True if we can create the folder and write a file in it. */
function writable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

let dataDir = null;
/** The folder for JSON files. If DATA_DIR can't be written (e.g. /data on a Render free instance,
 *  which has no disk), fall back to a writable folder so saves still work, and say so loudly. */
function folder() {
  if (dataDir) return dataDir;
  dataDir = [WANTED_DIR, LOCAL_DIR, path.join(os.tmpdir(), "aarambikallama-data")].find(writable) || WANTED_DIR;
  if (dataDir !== WANTED_DIR) {
    console.warn(`  Data: ${WANTED_DIR} is not writable, so data is saved in ${dataDir} instead.\n` +
      "  That folder is wiped on every redeploy/restart. Set DATABASE_URL (free Neon database) or attach a disk at DATA_DIR.");
  }
  return dataDir;
}

function readFile(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(folder(), name), "utf8"));
  } catch {
    return fallback;
  }
}

function writeFile(name, data) {
  const target = path.join(folder(), name);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, target);
}

// ---------------------------------------------------------------- postgres
let pool = null;
const cache = new Map(); // name -> value loaded at startup
const pending = new Map(); // name -> JSON text waiting to be saved (latest wins)
let flushing = null;

const UPSERT = `insert into app_data (key, value, updated_at) values ($1, $2::jsonb, now())
  on conflict (key) do update set value = excluded.value, updated_at = now()`;

async function initPostgres() {
  const { Pool } = require("pg");
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 15_000 });
  // Neon closes idle connections; without this listener that would crash the process.
  pool.on("error", (e) => console.warn("  Database connection dropped (will reconnect):", e.message));
  await pool.query(`create table if not exists app_data (key text primary key, value jsonb not null, updated_at timestamptz not null default now())`);
  const { rows } = await pool.query("select key, value from app_data");
  for (const r of rows) cache.set(r.key, r.value);

  // First run against an empty database: bring over any local JSON files.
  const imported = [];
  try {
    for (const f of fs.readdirSync(WANTED_DIR).filter((f) => f.endsWith(".json") && !cache.has(f))) {
      const value = JSON.parse(fs.readFileSync(path.join(WANTED_DIR, f), "utf8"));
      await pool.query(UPSERT, [f, JSON.stringify(value)]);
      cache.set(f, value);
      imported.push(f);
    }
  } catch {} // no local folder: nothing to import
  console.log(`  Data: Postgres database (${rows.length} saved item${rows.length === 1 ? "" : "s"}${imported.length ? `, imported ${imported.join(", ")}` : ""})`);
}

function savePostgres(name, data) {
  cache.set(name, data);
  pending.set(name, JSON.stringify(data)); // snapshot now; later edits get their own save
  flushing ??= flushPending();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function flushPending() {
  while (pending.size) {
    const [name, json] = pending.entries().next().value;
    pending.delete(name);
    try {
      await pool.query(UPSERT, [name, json]);
    } catch (e) {
      console.error(`  Saving ${name} to the database failed (retrying): ${e.message}`);
      if (!pending.has(name)) pending.set(name, json); // keep it unless a newer copy is already queued
      await sleep(3000);
    }
  }
  flushing = null;
}

// ---------------------------------------------------------------- public API
/** Load saved data. Must finish before any readJson call (see start.js). */
async function init() {
  if (usePostgres()) await initPostgres();
  else console.log(`  Data: files in ${folder()}`);
}

/** Wait for queued database saves (call before the process exits). */
async function flush(timeoutMs = 10_000) {
  if (!pool) return;
  await Promise.race([(async () => { while (flushing) await flushing; })(), sleep(timeoutMs)]);
}

/** Name of a stored document, e.g. file("users.json"). */
const file = (name) => name;

function readJson(name, fallback) {
  if (pool) return cache.has(name) ? cache.get(name) : fallback;
  return readFile(name, fallback);
}

function writeJson(name, data) {
  if (pool) return savePostgres(name, data);
  return writeFile(name, data);
}

const newId = () => crypto.randomBytes(8).toString("hex");

/** An Error carrying an HTTP status, for route handlers. */
function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

module.exports = { init, flush, file, readJson, writeJson, newId, httpError };
