// Shared helpers for all Aarambikallama pages.

/** Build a DOM element. Text children are inserted as text (never parsed as HTML). */
function h(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : String(c));
  }
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "style") node.style.cssText = v;
    else if (k === "value") node.value = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  return node;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: opts.body ? { "Content-Type": "application/json" } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 204) return null;
  if (res.status === 401 && !opts.allow401) {
    goToLogin();
    return new Promise(() => {}); // page is navigating away
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const SHAPES = ["●", "■", "▲", "◆"];

/** Animate a countdown bar + number. Returns a stop function. */
function startCountdown(barEl, numEl, remainingMs, totalMs) {
  const end = performance.now() + remainingMs;
  let raf = 0;
  const tick = () => {
    const left = Math.max(0, end - performance.now());
    if (barEl) barEl.style.width = `${(left / totalMs) * 100}%`;
    if (numEl) numEl.textContent = Math.ceil(left / 1000);
    if (left > 0) raf = requestAnimationFrame(tick);
  };
  tick();
  return () => cancelAnimationFrame(raf);
}

function timerBar(remainingMs, totalMs) {
  const bar = h("div");
  const num = h("span", { class: "timer-num" });
  const el = h("div", { class: "row", style: "flex-wrap:nowrap;gap:1rem" }, h("div", { class: "timer", style: "flex:1" }, bar), num);
  return { el, start: () => startCountdown(bar, num, remainingMs, totalMs) };
}

/** Round avatar photo for player number `n` (public/avatars/n.jpg). Size is in px. */
function avatarImg(n, size = 32, extraClass = "") {
  if (!Number.isInteger(n)) return null;
  return h("img", { class: `avatar ${extraClass}`.trim(), src: `/avatars/${n}.jpg`, alt: "", width: size, height: size, loading: "lazy", decoding: "async", style: `width:${size}px;height:${size}px` });
}

function podium(entries) {
  const order = [1, 0, 2]; // 2nd, 1st, 3rd
  return h(
    "div",
    { class: "podium" },
    order
      .filter((i) => entries[i])
      .map((i) =>
        h(
          "div",
          { class: `step p${i + 1}` },
          avatarImg(entries[i].avatar, i === 0 ? 72 : 56, "podium-avatar"),
          h("div", { class: "name" }, entries[i].name),
          h("div", { class: "muted" }, `${entries[i].score.toLocaleString()} pts`),
          h("div", { class: "block" }, i + 1),
        ),
      ),
  );
}

function goToLogin() {
  location.href = `/login.html?next=${encodeURIComponent(location.pathname + location.search)}`;
}

/** Topbar controls for logged-in teachers: name + log out. */
async function teacherMenu(...extra) {
  const me = await api("/api/auth/me");
  const initials = me.user.name.trim().split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return h("div", { class: "row" }, ...extra,
    h("span", { class: "user-chip hide-sm", title: me.user.email }, h("span", { class: "avatar" }, initials), me.user.name),
    h("button", { class: "btn-ghost btn-sm", onclick: async () => { await api("/api/auth/logout", { method: "POST" }); location.href = "/"; } }, "Log out"));
}

/** Brief message at the bottom of the screen. */
function toast(msg, ms = 2600) {
  document.querySelector(".toast")?.remove();
  const el = h("div", { class: "toast", role: "status" }, msg);
  document.body.append(el);
  setTimeout(() => el.remove(), ms);
}

const fmtDate = (ms) => new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
const qs = (name) => new URLSearchParams(location.search).get(name);
const topbar = (right) => h("header", { class: "topbar" }, h("a", { class: "logo", href: "/" }, "Aarambi", h("span", null, "kallama!")), right);
