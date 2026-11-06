// Entry point: load saved data (from Postgres or files) before the app reads it, then start the server.
const store = require("./lib/store");

store.init().then(
  () => require("./server"),
  (e) => {
    console.error(`Could not load data: ${e.message}\nCheck DATABASE_URL (or unset it to use local files).`);
    process.exit(1);
  },
);

// Render stops the old instance with SIGTERM on every deploy: save anything still queued first.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, async () => {
    await store.flush();
    process.exit(0);
  });
}
