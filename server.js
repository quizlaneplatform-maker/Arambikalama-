// Aarambikallama server: REST API for quizzes/reports + Socket.IO for live and self-paced games.
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const { file, readJson, writeJson, newId } = require("./lib/store");
const { authRouter, requireTeacher, userFromCookieHeader } = require("./lib/auth");
const { aiEnabled, generateQuestions } = require("./lib/ai");
const { checkMail, assertMailForProduction } = require("./lib/mailer");
assertMailForProduction();

const PORT = Number(process.env.PORT) || 3000;
const QUIZ_FILE = file("quizzes.json");
const REPORT_FILE = file("reports.json");
const MAX_PLAYERS = 200;
const GAME_TTL_MS = 30 * 60 * 1000; // keep finished games around for late viewers

// ---------------------------------------------------------------- storage
let quizzes = readJson(QUIZ_FILE, []);
let reports = readJson(REPORT_FILE, []);
const saveQuizzes = () => writeJson(QUIZ_FILE, quizzes);
const saveReports = () => writeJson(REPORT_FILE, reports);

// New teachers get a sample quiz; the very first teacher also adopts any quizzes/reports
// created before accounts existed.
function onSignup(user, isFirstUser) {
  if (isFirstUser) {
    for (const q of quizzes) q.ownerId ??= user.id;
    for (const r of reports) r.ownerId ??= user.id;
    saveReports();
  }
  quizzes.push({ ...sampleQuiz(), ownerId: user.id });
  saveQuizzes();
}

function sampleQuiz() {
  const q = (text, options, correctIndex, timeLimit = 20) => ({ text, options, correctIndex, timeLimit });
  return {
    id: newId(),
    title: "Science warm-up",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    questions: [
      q("Which planet is closest to the Sun?", ["Venus", "Mercury", "Mars", "Earth"], 1),
      q("What gas do plants absorb from the air for photosynthesis?", ["Oxygen", "Nitrogen", "Carbon dioxide", "Helium"], 2),
      q("Water boils at 100 °C at sea level.", ["True", "False"], 0, 10),
      q("What is the chemical symbol for sodium?", ["So", "Sd", "Na", "S"], 2),
      q("Which part of the cell contains genetic material?", ["Nucleus", "Cell wall", "Ribosome", "Vacuole"], 0),
    ],
  };
}

function cleanQuiz(body) {
  const title = String(body?.title ?? "").trim().slice(0, 120);
  if (!title) throw new Error("Give the quiz a title.");
  const raw = Array.isArray(body?.questions) ? body.questions : [];
  if (raw.length === 0) throw new Error("Add at least one question.");
  if (raw.length > 100) throw new Error("A quiz can have at most 100 questions.");
  const questions = raw.map((q, i) => {
    const n = i + 1;
    const text = String(q?.text ?? "").trim().slice(0, 300);
    if (!text) throw new Error(`Question ${n} needs text.`);
    const options = (Array.isArray(q?.options) ? q.options : []).map((o) => String(o ?? "").trim().slice(0, 120));
    if (options.length < 2 || options.length > 4) throw new Error(`Question ${n} needs 2 to 4 answer options.`);
    if (options.some((o) => !o)) throw new Error(`Question ${n} has an empty answer option.`);
    const correctIndex = Number(q?.correctIndex);
    if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= options.length)
      throw new Error(`Question ${n} needs a correct answer selected.`);
    const t = Number(q?.timeLimit);
    const timeLimit = Number.isFinite(t) ? Math.min(120, Math.max(5, Math.round(t))) : 20;
    return { text, options, correctIndex, timeLimit };
  });
  return { title, questions };
}

// ---------------------------------------------------------------- http
const PROD = process.env.NODE_ENV === "production";
const app = express();
app.disable("x-powered-by"); // don't advertise the framework
// Behind a hosting proxy (Render, Railway, Fly, nginx/Caddy) this makes req.secure and req.ip correct,
// so session cookies get the Secure flag and login lockouts are per real visitor.
const trustProxy = process.env.TRUST_PROXY ?? (PROD ? "1" : "");
if (trustProxy) app.set("trust proxy", /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);
app.get("/healthz", (req, res) => res.json({ ok: true }));
app.use((req, res, next) => {
  if (req.secure) res.setHeader("Strict-Transport-Security", "max-age=15552000");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY"); // no clickjacking via iframes
  res.setHeader("Referrer-Policy", "same-origin");
  next();
});
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.use("/api/auth", authRouter({ onSignup, aiEnabled }));
app.use(["/api/quizzes", "/api/reports", "/api/ai"], requireTeacher);

const summary = (q) => ({ id: q.id, title: q.title, questionCount: q.questions.length, updatedAt: q.updatedAt });
const ownQuiz = (req) => quizzes.find((q) => q.id === req.params.id && q.ownerId === req.user.id);
const ownReports = (req) => reports.filter((r) => r.ownerId === req.user.id);

app.get("/api/quizzes", (req, res) =>
  res.json(quizzes.filter((q) => q.ownerId === req.user.id).map(summary).sort((a, b) => b.updatedAt - a.updatedAt)),
);
app.get("/api/quizzes/:id", (req, res) => {
  const quiz = ownQuiz(req);
  quiz ? res.json(quiz) : res.status(404).json({ error: "Quiz not found" });
});
app.post("/api/quizzes", (req, res) => {
  try {
    const quiz = { id: newId(), ownerId: req.user.id, ...cleanQuiz(req.body), createdAt: Date.now(), updatedAt: Date.now() };
    quizzes.push(quiz);
    saveQuizzes();
    res.status(201).json(quiz);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.put("/api/quizzes/:id", (req, res) => {
  const quiz = ownQuiz(req);
  if (!quiz) return res.status(404).json({ error: "Quiz not found" });
  try {
    Object.assign(quiz, cleanQuiz(req.body), { updatedAt: Date.now() });
    saveQuizzes();
    res.json(quiz);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.delete("/api/quizzes/:id", (req, res) => {
  const quiz = ownQuiz(req);
  if (!quiz) return res.status(404).json({ error: "Quiz not found" });
  quizzes = quizzes.filter((q) => q !== quiz);
  saveQuizzes();
  res.status(204).end();
});

app.post("/api/ai/generate", async (req, res) => {
  try {
    res.json(await generateQuestions(req.user, req.body));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : "Something went wrong generating questions." });
    if (!e.status) console.error(e);
  }
});

app.get("/api/reports", (req, res) =>
  res.json(
    ownReports(req)
      .map((r) => ({
        id: r.id,
        quizTitle: r.quizTitle,
        mode: r.mode,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        playerCount: r.players.length,
        accuracy: r.accuracy,
      }))
      .sort((a, b) => b.endedAt - a.endedAt),
  ),
);
app.get("/api/reports/:id", (req, res) => {
  const r = ownReports(req).find((x) => x.id === req.params.id);
  r ? res.json(r) : res.status(404).json({ error: "Report not found" });
});
app.delete("/api/reports/:id", (req, res) => {
  reports = reports.filter((r) => !(r.id === req.params.id && r.ownerId === req.user.id));
  saveReports();
  res.status(204).end();
});

// Unknown API routes and bad request bodies get JSON errors (never Express's HTML page with a stack trace).
app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status === 400 ? "The request couldn't be read." : status >= 500 ? "Something went wrong." : err.message });
});

// ---------------------------------------------------------------- games
const server = http.createServer(app);
const io = new Server(server);
const games = new Map(); // code -> game

function newCode() {
  let code;
  do code = String(crypto.randomInt(100000, 1000000));
  while (games.has(code));
  return code;
}

const answerOf = (p, qi) => p.answers[qi];
const correctCount = (p) => Object.values(p.answers).filter((a) => a.correct).length;
const answeredCount = (p) => Object.keys(p.answers).length;

function leaderboard(g) {
  return [...g.players.values()]
    .map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      streak: p.streak,
      correct: correctCount(p),
      answered: answeredCount(p),
      connected: !!p.socketId,
      finished: !!p.finished,
    }))
    .sort((a, b) => b.score - a.score || b.correct - a.correct || a.name.localeCompare(b.name));
}
const rankOf = (g, id) => leaderboard(g).findIndex((e) => e.id === id) + 1;

// Points: 600 for a correct answer, up to +400 for speed, +100 per streak step (max +500).
// Live games wait for every student, so a correct answer after the timer still scores (just no speed bonus).
// Self-paced questions close when their timer ends.
function recordAnswer(g, p, qi, choice) {
  if (answerOf(p, qi)) return;
  const q = g.quiz.questions[qi];
  const started = g.mode === "live" ? g.qStartedAt : p.qStartedAt;
  const limitMs = q.timeLimit * 1000;
  const elapsed = Date.now() - started;
  const valid = Number.isInteger(choice) && choice >= 0 && choice < q.options.length;
  const inTime = g.mode === "live" || elapsed <= limitMs + 1000;
  const correct = valid && inTime && choice === q.correctIndex;
  let points = 0;
  if (correct) {
    p.streak += 1;
    const speed = 1 - Math.min(elapsed, limitMs) / limitMs;
    points = Math.round(600 + 400 * speed + Math.min(p.streak - 1, 5) * 100);
  } else {
    p.streak = 0;
  }
  p.score += points;
  p.answers[qi] = { choice: valid ? choice : null, correct, points, timeMs: Math.min(elapsed, limitMs) };
}

function publicQuestion(q, index, startedAt) {
  return {
    index,
    text: q.text,
    options: q.options,
    timeLimit: q.timeLimit,
    remainingMs: Math.max(0, q.timeLimit * 1000 - (Date.now() - startedAt)),
  };
}

function playerState(g, p) {
  const total = g.quiz.questions.length;
  const base = {
    code: g.code,
    mode: g.mode,
    quizTitle: g.quiz.title,
    name: p.name,
    score: p.score,
    streak: p.streak,
    rank: rankOf(g, p.id),
    playerCount: g.players.size,
    total,
    correct: correctCount(p),
  };
  if (g.status === "lobby") return { ...base, view: "lobby" };
  if (g.status === "finished")
    return { ...base, view: "finished", podium: leaderboard(g).slice(0, 5).map(({ name, score }) => ({ name, score })) };
  if (g.mode === "self" && p.finished) return { ...base, view: "done" };

  const qi = g.mode === "live" ? g.qIndex : p.qIndex;
  const q = g.quiz.questions[qi];
  const question = publicQuestion(q, qi, g.mode === "live" ? g.qStartedAt : p.qStartedAt);
  const a = answerOf(p, qi);
  const showResult = g.mode === "live" ? g.status === "reveal" : !!p.feedback;
  if (showResult)
    return {
      ...base,
      view: "result",
      question,
      isLast: qi === total - 1,
      result: { choice: a?.choice ?? null, correct: !!a?.correct, points: a?.points ?? 0, correctIndex: q.correctIndex },
    };
  if (a) return { ...base, view: "answered", question, choice: a.choice };
  return { ...base, view: "question", question };
}

function hostState(g) {
  const state = {
    code: g.code,
    mode: g.mode,
    status: g.status,
    quizTitle: g.quiz.title,
    total: g.quiz.questions.length,
    players: leaderboard(g),
    reportId: g.reportId ?? null,
  };
  if (g.mode === "live" && (g.status === "question" || g.status === "reveal")) {
    const q = g.quiz.questions[g.qIndex];
    const answers = [...g.players.values()].map((p) => answerOf(p, g.qIndex)).filter(Boolean);
    state.question = { ...publicQuestion(q, g.qIndex, g.qStartedAt), correctIndex: q.correctIndex };
    state.answeredCount = answers.length;
    state.waitingFor = [...g.players.values()].filter((p) => p.socketId && !answerOf(p, g.qIndex)).map((p) => p.name);
    if (g.status === "reveal") {
      state.distribution = q.options.map((_, i) => answers.filter((a) => a.choice === i).length);
      state.noAnswer = answers.filter((a) => a.choice === null).length;
    }
  }
  return state;
}

const pushHost = (g) => io.to(`host:${g.code}`).emit("state", hostState(g));
const pushPlayer = (g, p) => p.socketId && io.to(p.socketId).emit("state", playerState(g, p));
function pushAll(g) {
  pushHost(g);
  for (const p of g.players.values()) pushPlayer(g, p);
}

// ---- live mode
function startQuestion(g, qi) {
  clearTimeout(g.timer);
  const q = g.quiz.questions[qi];
  g.status = "question";
  g.qIndex = qi;
  g.qStartedAt = Date.now();
  // No auto-reveal when the timer ends: the answer is revealed once every connected student has answered
  // (see revealIfEveryoneAnswered), or when the host presses "Reveal answer now".
  pushAll(g);
}
function reveal(g) {
  if (g.status !== "question") return;
  clearTimeout(g.timer);
  for (const p of g.players.values()) recordAnswer(g, p, g.qIndex, null); // no-ops for players who answered
  g.status = "reveal";
  pushAll(g);
}
function revealIfEveryoneAnswered(g) {
  if (g.mode !== "live" || g.status !== "question") return;
  const active = [...g.players.values()].filter((p) => p.socketId);
  if (active.length > 0 && active.every((p) => answerOf(p, g.qIndex))) reveal(g);
}

// ---- self-paced mode
function serveSelf(g, p) {
  clearTimeout(p.timer);
  if (p.qIndex >= g.quiz.questions.length) {
    p.finished = true;
    return;
  }
  const q = g.quiz.questions[p.qIndex];
  p.feedback = false;
  p.qStartedAt = Date.now();
  p.timer = setTimeout(() => {
    recordAnswer(g, p, p.qIndex, null);
    p.feedback = true;
    pushPlayer(g, p);
    pushHost(g);
  }, q.timeLimit * 1000 + 300);
}

// ---- finishing
function finish(g) {
  if (g.status === "finished") return;
  clearTimeout(g.timer);
  for (const p of g.players.values()) clearTimeout(p.timer);
  g.status = "finished";
  if (g.players.size > 0 && g.startedAt) {
    const report = buildReport(g);
    reports.push(report);
    saveReports();
    g.reportId = report.id;
  }
  pushAll(g);
  setTimeout(() => games.delete(g.code), GAME_TTL_MS);
}

function buildReport(g) {
  const qs = g.quiz.questions;
  const players = leaderboard(g).map((e) => {
    const p = g.players.get(e.id);
    return {
      name: p.name,
      score: p.score,
      correct: e.correct,
      answered: e.answered,
      answers: qs.map((_, i) => p.answers[i] ?? null),
    };
  });
  const questions = qs.map((q, i) => {
    const answers = players.map((p) => p.answers[i]).filter(Boolean);
    const correct = answers.filter((a) => a.correct).length;
    return {
      text: q.text,
      options: q.options,
      correctIndex: q.correctIndex,
      distribution: q.options.map((_, k) => answers.filter((a) => a.choice === k).length),
      noAnswer: answers.filter((a) => a.choice === null).length,
      answered: answers.length,
      correct,
      accuracy: answers.length ? Math.round((correct / answers.length) * 100) : null,
    };
  });
  const totalAnswered = players.reduce((s, p) => s + p.answered, 0);
  const totalCorrect = players.reduce((s, p) => s + p.correct, 0);
  return {
    id: newId(),
    ownerId: g.ownerId,
    code: g.code,
    quizId: g.quizId,
    quizTitle: g.quiz.title,
    mode: g.mode,
    startedAt: g.startedAt,
    endedAt: Date.now(),
    accuracy: totalAnswered ? Math.round((totalCorrect / totalAnswered) * 100) : null,
    players,
    questions,
  };
}

// ---- sockets
io.on("connection", (socket) => {
  const reply = (ack, payload) => typeof ack === "function" && ack(payload);
  const hostGame = () => {
    const g = games.get(socket.data.hostOf);
    return g && g.status !== "finished" ? g : null;
  };
  function attachHost(g) {
    socket.data.hostOf = g.code;
    socket.join(`host:${g.code}`);
    pushHost(g);
  }

  socket.on("host:create", ({ quizId, mode } = {}, ack) => {
    const user = userFromCookieHeader(socket.handshake.headers.cookie);
    if (!user) return reply(ack, { error: "Please log in to host a game.", needLogin: true });
    const quiz = quizzes.find((q) => q.id === quizId && q.ownerId === user.id);
    if (!quiz) return reply(ack, { error: "Quiz not found" });
    const g = {
      code: newCode(),
      hostKey: crypto.randomBytes(16).toString("hex"),
      ownerId: user.id,
      quizId,
      quiz: structuredClone(quiz),
      mode: mode === "self" ? "self" : "live",
      status: "lobby",
      players: new Map(),
      qIndex: -1,
      qStartedAt: 0,
      timer: null,
      startedAt: null,
    };
    games.set(g.code, g);
    reply(ack, { code: g.code, hostKey: g.hostKey });
    attachHost(g);
  });

  socket.on("host:resume", ({ code, hostKey } = {}, ack) => {
    const g = games.get(String(code));
    if (!g) return reply(ack, { error: "This game has expired." });
    // The host key lives in one tab's sessionStorage; the logged-in owner may also reopen the game from any tab.
    const owner = userFromCookieHeader(socket.handshake.headers.cookie);
    const isOwner = owner && owner.id === g.ownerId;
    if (g.hostKey !== hostKey && !isOwner) return reply(ack, { error: "This game has expired." });
    reply(ack, { code: g.code, hostKey: isOwner ? g.hostKey : undefined });
    attachHost(g);
  });

  socket.on("host:start", () => {
    const g = hostGame();
    if (!g || g.status !== "lobby" || g.players.size === 0) return;
    g.startedAt = Date.now();
    if (g.mode === "live") return startQuestion(g, 0);
    g.status = "running";
    for (const p of g.players.values()) serveSelf(g, p);
    pushAll(g);
  });

  socket.on("host:next", () => {
    const g = hostGame();
    if (!g || g.mode !== "live") return;
    if (g.status === "question") return reveal(g); // skip the rest of the timer
    if (g.status !== "reveal") return;
    if (g.qIndex + 1 < g.quiz.questions.length) startQuestion(g, g.qIndex + 1);
    else finish(g);
  });

  socket.on("host:end", () => {
    const g = hostGame();
    if (g) finish(g);
  });

  socket.on("host:kick", ({ playerId } = {}) => {
    const g = hostGame();
    const p = g?.players.get(playerId);
    if (!p) return;
    clearTimeout(p.timer);
    g.players.delete(playerId);
    if (p.socketId) io.to(p.socketId).emit("kicked");
    pushHost(g);
    revealIfEveryoneAnswered(g);
  });

  socket.on("player:join", ({ code, name, playerId } = {}, ack) => {
    const g = games.get(String(code ?? "").trim());
    if (!g) return reply(ack, { error: "No game found with that code." });

    let p = playerId ? g.players.get(playerId) : null;
    if (!p) {
      if (g.status === "finished") return reply(ack, { error: "This game has already ended." });
      const clean = String(name ?? "").trim().replace(/\s+/g, " ").slice(0, 20);
      if (!clean) return reply(ack, { error: "Enter a nickname.", needName: true });
      if ([...g.players.values()].some((x) => x.name.toLowerCase() === clean.toLowerCase()))
        return reply(ack, { error: "That nickname is taken. Try another.", needName: true });
      if (g.players.size >= MAX_PLAYERS) return reply(ack, { error: "This game is full." });
      p = { id: newId(), name: clean, score: 0, streak: 0, answers: {}, qIndex: 0, finished: false, feedback: false };
      g.players.set(p.id, p);
      if (g.mode === "self" && g.status === "running") serveSelf(g, p);
    }
    p.socketId = socket.id;
    socket.data.player = { code: g.code, id: p.id };
    reply(ack, { playerId: p.id });
    pushPlayer(g, p);
    pushHost(g);
  });

  const currentPlayer = () => {
    const ref = socket.data.player;
    const g = ref && games.get(ref.code);
    const p = g?.players.get(ref.id);
    return g && p && p.socketId === socket.id ? { g, p } : null;
  };

  socket.on("player:answer", ({ index, choice } = {}) => {
    const cur = currentPlayer();
    if (!cur) return;
    const { g, p } = cur;
    if (g.mode === "live") {
      if (g.status !== "question" || index !== g.qIndex) return;
      recordAnswer(g, p, g.qIndex, choice);
      pushPlayer(g, p);
      pushHost(g);
      revealIfEveryoneAnswered(g);
    } else {
      if (g.status !== "running" || p.finished || p.feedback || index !== p.qIndex) return;
      clearTimeout(p.timer);
      recordAnswer(g, p, p.qIndex, choice);
      p.feedback = true;
      pushPlayer(g, p);
      pushHost(g);
    }
  });

  socket.on("player:next", () => {
    const cur = currentPlayer();
    if (!cur) return;
    const { g, p } = cur;
    if (g.mode !== "self" || g.status !== "running" || !p.feedback) return;
    p.qIndex += 1;
    serveSelf(g, p);
    pushPlayer(g, p);
    pushHost(g);
  });

  socket.on("disconnect", () => {
    const cur = currentPlayer();
    if (!cur) return;
    cur.p.socketId = null;
    pushHost(cur.g);
    revealIfEveryoneAnswered(cur.g);
  });
});

server.listen(PORT, () => {
  console.log(`Aarambikallama running at http://localhost:${PORT}`);
  console.log(aiEnabled() ? "  AI question generation: on (Grok)" : "  AI question generation: off (set XAI_API_KEY in .env)");
  checkMail();
  for (const addrs of Object.values(os.networkInterfaces()))
    for (const a of addrs ?? [])
      if (a.family === "IPv4" && !a.internal) console.log(`  On your network: http://${a.address}:${PORT}`);
});
