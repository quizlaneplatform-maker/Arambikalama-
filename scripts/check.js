// `npm run build`: this app has no bundling step, so "build" verifies the code instead:
// every server module parses, and every inline <script> in public/*.html parses.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
let failed = 0;
const ok = (msg) => console.log(`  ok    ${msg}`);
const fail = (msg, e) => { failed++; console.error(`  FAIL  ${msg}\n        ${String(e.message || e).split("\n")[0]}`); };

const serverFiles = ["start.js", "server.js", ...fs.readdirSync(path.join(root, "lib")).filter((f) => f.endsWith(".js")).map((f) => `lib/${f}`)];
for (const f of serverFiles) {
  try { execFileSync(process.execPath, ["--check", path.join(root, f)], { stdio: "pipe" }); ok(f); }
  catch (e) { fail(f, e.stderr?.toString() || e); }
}

for (const f of ["public/common.js", "public/theme.js"]) {
  try { new vm.Script(fs.readFileSync(path.join(root, f), "utf8"), { filename: f }); ok(f); }
  catch (e) { fail(f, e); }
}

for (const f of fs.readdirSync(path.join(root, "public")).filter((f) => f.endsWith(".html"))) {
  const html = fs.readFileSync(path.join(root, "public", f), "utf8");
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  try { scripts.forEach((code, i) => new vm.Script(code, { filename: `${f} <script #${i + 1}>` })); ok(`public/${f} (${scripts.length} inline script${scripts.length === 1 ? "" : "s"})`); }
  catch (e) { fail(`public/${f}`, e); }
}

if (failed) { console.error(`\n${failed} file(s) failed.`); process.exit(1); }
console.log("\nBuild check passed.");
