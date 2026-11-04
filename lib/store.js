// Tiny JSON-file persistence helpers.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// On a host, point DATA_DIR at a persistent disk/volume so data survives redeploys.
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, "..", "data");

function file(name) {
  return path.join(DATA_DIR, name);
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

const newId = () => crypto.randomBytes(8).toString("hex");

/** An Error carrying an HTTP status, for route handlers. */
function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

module.exports = { file, readJson, writeJson, newId, httpError };
