// AI quiz question generation with xAI's Grok (OpenAI-compatible chat completions API).
const { httpError } = require("./store");

const BASE_URL = (process.env.XAI_BASE_URL || "https://api.x.ai/v1").replace(/\/+$/, "");
const MODEL = process.env.XAI_MODEL || "grok-4.7";
const REQUESTS_PER_HOUR = 30;
const usage = new Map(); // userId -> timestamps of recent requests

const aiEnabled = () => Boolean(process.env.XAI_API_KEY);

const quizSchema = (count) => ({
  type: "object",
  properties: {
    title: { type: "string", maxLength: 120, description: "Short quiz title" },
    questions: {
      type: "array",
      minItems: 1,
      maxItems: count,
      items: {
        type: "object",
        properties: {
          text: { type: "string", maxLength: 300 },
          options: { type: "array", minItems: 2, maxItems: 4, items: { type: "string", maxLength: 120 } },
          correctIndex: { type: "integer", minimum: 0, maximum: 3, description: "0-based index into options" },
          timeLimit: { type: "integer", minimum: 5, maximum: 120, description: "Seconds to answer" },
        },
        required: ["text", "options", "correctIndex", "timeLimit"],
        additionalProperties: false,
      },
    },
  },
  required: ["title", "questions"],
  additionalProperties: false,
});

function checkRateLimit(userId) {
  const hourAgo = Date.now() - 60 * 60 * 1000;
  const recent = (usage.get(userId) || []).filter((t) => t > hourAgo);
  if (recent.length >= REQUESTS_PER_HOUR)
    throw httpError(429, `You've reached the limit of ${REQUESTS_PER_HOUR} AI generations per hour. Try again later.`);
  recent.push(Date.now());
  usage.set(userId, recent);
}

/** Shuffle answer options (models tend to favour one position), except true/false pairs. */
function shuffleOptions(q) {
  const isTrueFalse = q.options.length === 2 && q.options.map((o) => o.toLowerCase()).join() === "true,false";
  if (isTrueFalse) return q;
  const order = q.options.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return { ...q, options: order.map((i) => q.options[i]), correctIndex: order.indexOf(q.correctIndex) };
}

function cleanQuestion(q) {
  const text = String(q?.text ?? "").trim().slice(0, 300);
  const options = (Array.isArray(q?.options) ? q.options : []).map((o) => String(o ?? "").trim().slice(0, 120));
  const correctIndex = Number(q?.correctIndex);
  const t = Number(q?.timeLimit);
  if (!text || options.length < 2 || options.length > 4 || options.some((o) => !o)) return null;
  if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) return null;
  if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= options.length) return null;
  return { text, options, correctIndex, timeLimit: Number.isFinite(t) ? Math.min(120, Math.max(5, Math.round(t))) : 20 };
}

async function generateQuestions(user, input) {
  if (!aiEnabled()) throw httpError(503, "AI generation isn't set up. Add XAI_API_KEY to the .env file and restart the server.");
  const topic = String(input?.topic ?? "").trim().slice(0, 300);
  if (!topic) throw httpError(400, "Enter a topic for the questions.");
  const count = Math.min(20, Math.max(1, Math.round(Number(input?.count) || 5)));
  const difficulty = ["easy", "medium", "hard"].includes(input?.difficulty) ? input.difficulty : "medium";
  const gradeLevel = String(input?.gradeLevel ?? "").trim().slice(0, 60);
  const notes = String(input?.notes ?? "").trim().slice(0, 1000);
  checkRateLimit(user.id);

  const request = [
    `Topic: ${topic}`,
    `Number of questions: ${count}`,
    `Difficulty: ${difficulty}`,
    gradeLevel && `Grade level / audience: ${gradeLevel}`,
    notes && `Teacher's extra instructions: ${notes}`,
  ]
    .filter(Boolean)
    .join("\n");

  let res;
  try {
    res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.XAI_API_KEY}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: "system",
            content:
              "You write multiple-choice questions for classroom quiz games. Rules: every question has exactly one " +
              "unambiguously correct answer; give 4 options unless it is a true/false question (then exactly " +
              '["True", "False"]); keep questions under 200 characters and options under 80; wrong options must be ' +
              "plausible but clearly wrong; facts must be accurate; no trick questions; no 'all/none of the above'. " +
              "Choose timeLimit by reading load: 10 for true/false, 20 for typical questions, 30-45 for ones that need working out.",
          },
          { role: "user", content: request },
        ],
        response_format: { type: "json_schema", json_schema: { name: "quiz", schema: quizSchema(count), strict: true } },
      }),
    });
  } catch (e) {
    console.error("Grok request failed:", e.message);
    throw httpError(502, e.name === "TimeoutError" ? "Grok took too long to respond. Try fewer questions." : "Couldn't reach Grok. Check your internet connection.");
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(`Grok API error ${res.status}: ${detail.slice(0, 500)}`);
    // xAI answers an invalid key with 400 "Incorrect API key provided", not only 401/403.
    if (res.status === 401 || res.status === 403 || /api key/i.test(detail)) throw httpError(502, "Grok rejected the API key. Check XAI_API_KEY in .env.");
    if (res.status === 404) throw httpError(502, `Grok model "${MODEL}" wasn't found. Set XAI_MODEL in .env to a model your key can use.`);
    if (res.status === 429) throw httpError(429, "Grok's rate limit or credit limit was reached. Try again shortly.");
    throw httpError(502, `Grok returned an error (${res.status}). Try again.`);
  }

  let parsed;
  try {
    const data = await res.json();
    parsed = JSON.parse(data.choices?.[0]?.message?.content ?? "");
  } catch {
    throw httpError(502, "Grok's reply couldn't be read. Try again.");
  }
  const questions = (Array.isArray(parsed?.questions) ? parsed.questions : []).map(cleanQuestion).filter(Boolean).slice(0, count).map(shuffleOptions);
  if (!questions.length) throw httpError(502, "Grok didn't return any usable questions. Try rewording the topic.");
  return { title: String(parsed.title ?? topic).trim().slice(0, 120) || topic, questions, model: MODEL };
}

module.exports = { aiEnabled, generateQuestions };
