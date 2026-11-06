// Import a quiz from a Word document (.docx).
// The document is converted to simple HTML with mammoth, flattened into lines (keeping list depth,
// headings and bold), then read with the formats teachers commonly type quizzes in:
//   questions  "1. ...", "Q1) ...", "Question 1: ...", Word's automatic numbering, or a line ending in "?"
//   options    "A) ...", "(b) ...", "c. ...", bullets / sub-list items, plain lines under a question,
//              or several on one line: "A) Paris  B) London  C) Rome"
//   answers    "Answer: B" / "Ans - Paris" under a question, an answer key at the end ("1. B, 2. C"),
//              a marker on the option ("*", "✓", "(correct)"), or the only bold option
// Questions without a recognisable answer come back with needsAnswer so the teacher picks one.
const mammoth = require("mammoth");

const MAX_QUESTIONS = 100;

// ---------------------------------------------------------------- docx -> lines
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) =>
    e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m);

const BLOCK = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "td", "th", "tr", "ol", "ul", "table", "br"]);

/** Flatten mammoth's HTML into lines: { text, tag, depth, listType, bold, cell }
 *  (bold = every letter is bold; cell = inside a table cell). */
function htmlToLines(html) {
  const lines = [];
  const lists = []; // stack of "ol" | "ul"
  let buf = "", boldChars = 0, letters = 0, strong = 0, tag = "p", cells = 0;
  const flush = () => {
    const text = buf.replace(/\s+/g, " ").trim();
    if (text) lines.push({ text, tag, depth: lists.length, listType: lists.at(-1) ?? null, bold: letters > 0 && boldChars === letters, cell: cells > 0 });
    buf = ""; boldChars = 0; letters = 0;
  };
  for (const m of html.matchAll(/<(\/?)([a-z0-9]+)[^>]*>|([^<]+)/gi)) {
    if (m[3] !== undefined) {
      const t = decode(m[3]);
      buf += t;
      const n = (t.match(/[\p{L}\p{N}]/gu) || []).length;
      letters += n;
      if (strong) boldChars += n;
      continue;
    }
    const [, close, name] = m;
    const t = name.toLowerCase();
    if (t === "strong" || t === "b") { strong += close ? -1 : 1; continue; }
    if (!BLOCK.has(t)) continue;
    flush();
    if (t === "td" || t === "th") cells += close ? -1 : 1;
    if (t === "ol" || t === "ul") close ? lists.pop() : lists.push(t);
    else if (!close && t !== "br" && t !== "tr" && t !== "table") tag = t;
  }
  flush();
  return lines;
}

// ---------------------------------------------------------------- patterns
const Q_NUMBERED = /^(?:q(?:uestion)?\s*\.?\s*)?(\d{1,3})\s*[.):\]\-–]\s*(.+)$/i; // 1. / Q1) / Question 1:
const Q_WORD = /^q(?:uestion)?\s*(\d{1,3})\s+(.+)$/i; // "Question 1 What ..."
const OPTION = /^[(\[]?([a-f])\s*[)\].:]\s*(.*)$/i; // A) / (b) / c. / [d]
const BULLET = /^[-•▪◦●○*–]\s+(.+)$/;
const ANSWER = /^(?:the\s+)?(?:correct\s+)?(?:answer|ans|solution|key)s?\s*(?:is)?\s*[:.\-–=)]\s*(.+)$/i;
const ANSWER_BARE = /^(?:correct\s+)?(?:answer|ans)\s+(?:is\s+)?\(?([a-f])\)?\.?$/i;
const KEY_HEADING = /^(?:answer\s*key|answers?|key|answer\s*sheet|solutions?|marking\s*scheme)\s*:?\s*$/i;
const LETTER_ONLY = /^\(?([a-f])\)?\.?$/i;
const KEY_LINE = /^(?:\s*\d{1,3}\s*[.):\-–=]?\s*\(?[a-f]\)?\s*[,;]?)+\s*$/i; // "1. A  2. B, 3-c"
const TRUE_FALSE = /^(?:true\s*[/|,]\s*false|t\s*\/\s*f)$/i;
const MARK_START = /^\s*(?:\*+|✓|✔|☑|✅)\s*/;
const MARK_END = /\s*(?:\*+|✓|✔|☑|✅|\((?:correct|answer|right|ans)\)|\[(?:correct|answer|right|ans)\]|<-+\s*(?:correct|answer))\s*$/i;
const MARKS_SUFFIX = /\s*[([]\s*\d+\s*(?:marks?|pts?|points?)?\s*[)\]]\s*$/i;

/** Split "A) Paris B) London C) Rome" into options (letters must run a, b, c...). */
function inlineOptions(text) {
  const found = [...text.matchAll(/(?:^|\s)[(\[]?([a-f])[)\].]\s+/gi)];
  const run = [];
  for (const m of found) if (m[1].toLowerCase().charCodeAt(0) - 97 === run.length) run.push(m);
  if (run.length < 2) return null;
  const opts = run.map((m, i) => text.slice(m.index + m[0].length, run[i + 1]?.index ?? text.length).trim());
  return { before: text.slice(0, run[0].index).trim(), options: opts };
}

/** Strip and report a "correct answer" marker on an option. */
function unmark(text) {
  let marked = false;
  const out = text.replace(MARK_START, () => ((marked = true), "")).replace(MARK_END, () => ((marked = true), ""));
  return { text: out.trim(), marked };
}

const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Turn an answer ("B", "(c)", "Paris", "True") into an option index, or -1. */
function answerIndex(answer, options) {
  if (answer == null) return -1;
  const a = String(answer).trim();
  const letter = /^\(?([a-f])\)?(?:[\s.):\-]|$)/i.exec(a);
  if (letter) {
    const i = letter[1].toLowerCase().charCodeAt(0) - 97;
    if (i < options.length) return i;
  }
  const n = norm(a.replace(/^\(?[a-f]\)?[.):\-]\s*/i, ""));
  if (!n) return -1;
  let i = options.findIndex((o) => norm(o) === n);
  if (i < 0 && /^t(rue)?$/.test(n)) i = options.findIndex((o) => norm(o) === "true");
  if (i < 0 && /^f(alse)?$/.test(n)) i = options.findIndex((o) => norm(o) === "false");
  if (i < 0) i = options.findIndex((o) => norm(o) && (n.includes(norm(o)) || norm(o).includes(n)));
  return i;
}

// ---------------------------------------------------------------- lines -> quiz
function parseLines(lines, fallbackTitle) {
  const keyAt = lines.findIndex((l) => !l.cell && KEY_HEADING.test(l.text));
  const body = keyAt < 0 ? lines : lines.slice(0, keyAt);
  const typedNumbers = body.some((l) => Q_NUMBERED.test(l.text) && !KEY_LINE.test(l.text));
  const olDepths = lines.filter((l) => l.listType === "ol").map((l) => l.depth);
  const autoDepth = !typedNumbers && olDepths.length ? Math.min(...olDepths) : null; // Word's own numbering

  const questions = [];
  const key = new Map(); // question number -> answer (from an answer key)
  const preamble = [];
  let q = null, keyMode = false, pendingNum = null;

  const start = (num, text, line) => {
    q = { num: num ?? pendingNum ?? questions.length + 1, text, options: [], marked: [], bold: [], answer: null, depth: line.depth };
    questions.push(q);
  };
  const addOption = (raw, line) => {
    const { text, marked } = unmark(raw);
    if (!text) return;
    if (marked) q.marked.push(q.options.length);
    if (line?.bold) q.bold.push(q.options.length);
    q.options.push(text);
  };
  const keyEntries = (text) => {
    let any = false;
    for (const m of text.matchAll(/(\d{1,3})\s*[.):\-–=]?\s*\(?([a-f])\)?(?![\p{L}])/giu)) { key.set(Number(m[1]), m[2]); any = true; }
    if (!any) { const m = /^(\d{1,3})\s*[.):\-–=]\s*(.+)$/.exec(text); if (m) { key.set(Number(m[1]), m[2]); any = true; } }
    return any;
  };

  for (const line of lines) {
    const t = line.text;
    // A table's "No." cell: a lone number that is the next question's number (not a numeric answer like "54").
    if (line.cell && /^(?:q\s*)?\d{1,3}[.)]?$/i.test(t) && Number(t.replace(/\D/g, "")) === questions.length + 1 && (!q || q.options.length >= 2)) {
      pendingNum = Number(t.replace(/\D/g, ""));
      continue;
    }
    if (!line.cell && KEY_HEADING.test(t)) { keyMode = true; continue; }
    if (keyMode) { keyEntries(t); continue; }

    // An answer for the current question.
    const ans = q && (ANSWER.exec(t) || ANSWER_BARE.exec(t));
    if (ans) { q.answer = ans[1].trim(); continue; }
    if (q && q.options.length >= 2 && LETTER_ONLY.test(t)) { q.answer = t; continue; } // table "answer" cell

    // A new question?
    let m = Q_NUMBERED.exec(t) || Q_WORD.exec(t);
    if (KEY_LINE.test(t)) { keyEntries(t); continue; } // "1. B" or "1-A 2-C" = answer key line
    const optionLike = OPTION.test(t) || BULLET.test(t);
    let isQuestion = false;
    if (m && !(OPTION.test(t) && q && !typedNumbers)) isQuestion = true;
    else if (autoDepth !== null && line.listType === "ol" && line.depth === autoDepth && !OPTION.test(t) &&
      (!q || q.options.length >= 2 || /[?:]\s*$/.test(t))) { isQuestion = true; m = null; }
    else if (!optionLike && /\?\s*$/.test(t) && (!q || q.options.length >= 2) && !(line.listType && q && line.depth > q.depth)) { isQuestion = true; m = null; }

    if (isQuestion) {
      const body = m ? m[2] : t;
      const inline = inlineOptions(body);
      start(m ? Number(m[1]) : null, inline ? inline.before : body, line);
      pendingNum = null;
      if (inline) for (const o of inline.options) addOption(o, null);
      continue;
    }
    if (!q) { preamble.push(line); continue; }

    // An option for the current question.
    const inline = inlineOptions(t);
    if (inline && !inline.before) { for (const o of inline.options) addOption(o, null); continue; }
    if (q.options.length === 0 && TRUE_FALSE.test(t)) { q.options.push("True", "False"); continue; }
    const marked = unmark(t);
    const opt = OPTION.exec(marked.text) || BULLET.exec(marked.text);
    if (opt) { addOption((marked.marked ? "* " : "") + (opt[2] ?? opt[1]), line); continue; }
    const nestedItem = line.listType && line.depth > q.depth;
    const questionDone = /[?:]\s*$/.test(q.text) || q.options.length > 0 || nestedItem || line.listType;
    if (questionDone || t.length <= 60) addOption(t, line);
    else q.text += ` ${t}`; // a question that runs over several lines
  }

  // Title: the first heading, else a short first line before the questions, else the file name.
  const heading = preamble.find((l) => /^h[1-3]$/.test(l.tag));
  const firstLine = preamble.find((l) => l.text.length <= 100 && !/\b(name|date|class|roll|marks|instructions?|time allowed)\b/i.test(l.text));
  const title = (heading || firstLine)?.text.replace(/:\s*$/, "").slice(0, 120) || fallbackTitle;

  const warnings = [];
  const out = [];
  for (const [i, raw] of questions.entries()) {
    const label = `Question ${raw.num ?? i + 1}`;
    const text = raw.text.replace(MARKS_SUFFIX, "").trim().slice(0, 300);
    let options = raw.options.map((o) => o.slice(0, 120)).filter(Boolean);
    if (!text) continue;
    let correct = raw.marked.length === 1 ? raw.marked[0] : -1;
    if (correct < 0) correct = answerIndex(raw.answer, options);
    if (correct < 0) correct = answerIndex(key.get(raw.num), options);
    if (correct < 0 && raw.bold.length === 1 && raw.bold.length < options.length) correct = raw.bold[0];
    if (options.length < 2) {
      if (/^(t(rue)?|f(alse)?)$/i.test(String(raw.answer ?? key.get(raw.num) ?? "").trim())) {
        options = ["True", "False"];
        correct = answerIndex(raw.answer ?? key.get(raw.num), options);
      } else {
        warnings.push(`${label} was skipped: it needs 2 to 4 answer options.`);
        continue;
      }
    }
    if (options.length > 4) {
      warnings.push(`${label} had ${options.length} options; only the first 4 were kept.`);
      options = options.slice(0, 4);
      if (correct >= 4) correct = -1;
    }
    const q2 = { text, options, correctIndex: Math.max(0, correct), timeLimit: 20 };
    if (correct < 0) q2.needsAnswer = true;
    out.push(q2);
    if (out.length === MAX_QUESTIONS) { warnings.push(`Only the first ${MAX_QUESTIONS} questions were imported.`); break; }
  }
  return { title, questions: out, warnings };
}

/** Read a .docx buffer and return { title, questions, warnings }. */
async function importWord(buf, fileName = "") {
  const err = (status, message) => Object.assign(new Error(message), { status });
  if (!Buffer.isBuffer(buf) || buf.length < 4) throw err(400, "Choose a Word file to import.");
  if (buf.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0])))
    throw err(415, "This is an old Word file (.doc). Open it in Word, choose Save As → Word Document (.docx), then import that.");
  if (!buf.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) throw err(415, "That isn't a Word document. Choose a .docx file.");
  let html;
  try {
    ({ value: html } = await mammoth.convertToHtml({ buffer: buf }));
  } catch {
    throw err(400, "This Word file couldn't be read. Open it in Word, save it again as .docx, and retry.");
  }
  const fallbackTitle = String(fileName).replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim().slice(0, 120) || "Imported quiz";
  const result = parseLines(htmlToLines(html), fallbackTitle);
  if (!result.questions.length)
    throw err(422, "No questions were found. Number each question (1., 2., ...) and put its options on the lines below it as A), B), C), D).");
  return result;
}

module.exports = { importWord, parseLines, htmlToLines };
