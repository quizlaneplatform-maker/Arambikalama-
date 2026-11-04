// Theme switcher: preset palettes, light/dark/auto mode and a custom accent colour.
// Loaded in <head> so the saved theme is applied before the page paints (no flash).
(function () {
  const THEMES = {
    blackberry: { name: "Blackberry", dark: "#3b142a", dark2: "#4a1c36", dark3: "#592643", darkLine: "#62304d", light: "#f3efda", light100: "#faf7eb", lightHover: "#e8dfb0", surface2: "#efe7c6", line: "#e3d9b4", muted: "#7a5a6b", accent: "#ff319f", ink: "#ffffff" },
    midnight: { name: "Midnight", dark: "#0f1a33", dark2: "#172446", dark3: "#1f3058", darkLine: "#2a3a63", light: "#eef1f8", light100: "#f8f9fd", lightHover: "#d9e0f0", surface2: "#e3e8f4", line: "#d3dbec", muted: "#56607a", accent: "#3a66f0" },
    forest: { name: "Forest", dark: "#12302a", dark2: "#1a3f37", dark3: "#245046", darkLine: "#2f5a4f", light: "#eef0e2", light100: "#f8f9f0", lightHover: "#dde2c4", surface2: "#e4e8d2", line: "#d5dbbf", muted: "#5a6b5f", accent: "#2fbf71" },
    ocean: { name: "Ocean", dark: "#002f42", dark2: "#0a3d52", dark3: "#154c63", darkLine: "#1f5a70", light: "#e9f4f3", light100: "#f6fbfb", lightHover: "#cfe6e3", surface2: "#dcecea", line: "#c9e0dd", muted: "#4d6a70", accent: "#ff6b5b" },
    grape: { name: "Grape", dark: "#241a40", dark2: "#2f2352", dark3: "#3a2b63", darkLine: "#4a3a78", light: "#f3effb", light100: "#faf8fe", lightHover: "#e1d8f3", surface2: "#e9e2f6", line: "#ddd3f0", muted: "#6a5f86", accent: "#9b5cff" },
    sunset: { name: "Sunset", dark: "#3a1a0c", dark2: "#4a2414", dark3: "#5c2f1c", darkLine: "#6b3c25", light: "#fbf1e4", light100: "#fffaf3", lightHover: "#f1dcc0", surface2: "#f5e6d1", line: "#ecd8bd", muted: "#7d5f4a", accent: "#ff7a1a" },
  };
  const ACCENTS = ["#ff319f", "#3a66f0", "#2fbf71", "#ff6b5b", "#9b5cff", "#ff7a1a", "#e8b100", "#00a6b4"];
  const KEY = "ql_theme";
  const root = document.documentElement;
  const darkQuery = matchMedia("(prefers-color-scheme: dark)");

  let state = { theme: "blackberry", mode: "light", accent: null };
  try { Object.assign(state, JSON.parse(localStorage.getItem(KEY) || "{}")); } catch {}
  if (!THEMES[state.theme]) state.theme = "blackberry";

  // ---- colour maths
  const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const lum = (h) => { const [r, g, b] = hexRgb(h).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  const mix = (a, b, t) => "#" + hexRgb(a).map((v, i) => Math.round(v + (hexRgb(b)[i] - v) * t).toString(16).padStart(2, "0")).join("");
  /** Button text colour: whichever of white / the theme's dark colour is easier to read on the accent. */
  const inkFor = (accent, dark) => (contrast(accent, "#ffffff") >= contrast(accent, dark) ? "#ffffff" : dark);

  function apply(animate) {
    const t = THEMES[state.theme];
    const accent = state.accent || t.accent;
    const vars = {
      "--blackberry": t.dark, "--blackberry-2": t.dark2, "--blackberry-3": t.dark3, "--blackberry-press": mix(t.dark, "#000000", 0.4), "--dark-line": t.darkLine,
      "--oat": t.light, "--oat-100": t.light100, "--oat-hover": t.lightHover, "--oat-press": mix(t.lightHover, "#000000", 0.08),
      "--surface-2": t.surface2, "--line": t.line, "--muted": t.muted,
      "--magenta": accent, "--magenta-hover": mix(accent, "#ffffff", 0.3), "--magenta-press": mix(accent, "#000000", 0.15),
      "--brand-ink": state.accent || !t.ink ? inkFor(accent, t.dark) : t.ink,
      "--opt0": accent,
    };
    if (animate) {
      root.classList.add("theme-anim");
      clearTimeout(apply.t);
      apply.t = setTimeout(() => root.classList.remove("theme-anim"), 500);
    }
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
    root.dataset.theme = state.theme;
    const dark = state.mode === "dark" || (state.mode === "auto" && darkQuery.matches);
    root.dataset.mode = dark ? "dark" : "light";
    const applyBody = () => {
      // Game screens are always dark; other pages follow the chosen mode.
      const gamePage = document.body.dataset.alwaysDark === "true";
      if (!("alwaysDark" in document.body.dataset)) document.body.dataset.alwaysDark = String(document.body.classList.contains("theme-dark"));
      document.body.classList.toggle("theme-dark", document.body.dataset.alwaysDark === "true" || dark);
    };
    document.body ? applyBody() : document.addEventListener("DOMContentLoaded", applyBody, { once: true });
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = t.dark;
  }

  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {} }
  function set(patch) {
    // Remember which control had focus so keyboard users stay in place after the panel re-renders.
    const a = document.activeElement;
    const sel = panel && panel.contains(a)
      ? (a.dataset.themeId && `[data-theme-id="${a.dataset.themeId}"]`) || (a.dataset.mode && `[data-mode="${a.dataset.mode}"]`) || (a.getAttribute("aria-label") && `[aria-label="${a.getAttribute("aria-label")}"]`) || (a.textContent && null)
      : null;
    Object.assign(state, patch); save(); apply(true); render();
    if (sel) panel?.querySelector(sel)?.focus();
  }

  apply(false);
  darkQuery.addEventListener?.("change", () => state.mode === "auto" && apply(true));

  // ---- UI
  let fab, panel;
  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) k.startsWith("on") ? n.addEventListener(k.slice(2), v) : n.setAttribute(k, v);
    n.append(...kids);
    return n;
  };

  function render() {
    if (!panel) return;
    const t = THEMES[state.theme];
    const accent = state.accent || t.accent;
    panel.replaceChildren(
      el("h3", { id: "theme-title" }, "🎨 Make it yours"),
      el("p", { class: "muted small", style: "margin:0" }, "Pick a theme, mode and accent. Changes apply instantly."),
      el("div", { class: "sec" }, el("div", { class: "lbl" }, "Theme"),
        el("div", { class: "theme-grid", role: "radiogroup", "aria-label": "Theme" },
          ...Object.entries(THEMES).map(([id, th]) => {
            const pv = el("span", { class: "pv", "aria-hidden": "true" },
              el("i", { style: `background:${th.dark}` }), el("i", { style: `background:${th.light}` }), el("i", { style: `background:${th.accent}` }));
            return el("button", { type: "button", class: "theme-card", role: "radio", "aria-checked": String(id === state.theme), "data-theme-id": id,
              onclick: () => set({ theme: id, accent: null }),
              onmouseenter: () => previewTheme(id), onmouseleave: () => apply(true), onfocus: () => previewTheme(id), onblur: () => apply(true) }, pv, th.name);
          }))),
      el("div", { class: "sec" }, el("div", { class: "lbl" }, "Mode"),
        el("div", { class: "seg", role: "radiogroup", "aria-label": "Mode" },
          ...[["auto", "🖥 Auto"], ["light", "☀️ Light"], ["dark", "🌙 Dark"]].map(([m, label]) =>
            el("button", { type: "button", role: "radio", "aria-checked": String(state.mode === m), "data-mode": m, onclick: () => set({ mode: m }) }, label)))),
      el("div", { class: "sec" }, el("div", { class: "lbl" }, "Accent colour"),
        el("div", { class: "swatches", role: "radiogroup", "aria-label": "Accent colour" },
          ...ACCENTS.map((c) => el("button", { type: "button", class: "swatch-btn", role: "radio", "aria-label": `Accent ${c}`, "aria-checked": String(accent.toLowerCase() === c), style: `background:${c}`,
            onclick: () => set({ accent: c === t.accent ? null : c }) })),
          el("label", { class: "custom-color", title: "Custom colour" },
            el("input", { type: "color", value: accent, "aria-label": "Custom accent colour",
              oninput: (e) => { state.accent = e.target.value; apply(false); }, onchange: (e) => set({ accent: e.target.value }) }))),
        el("button", { type: "button", class: "btn-sm theme-preview-btn", tabindex: "-1" }, "Preview button")),
      el("div", { class: "foot" },
        el("button", { type: "button", class: "btn-ghost btn-sm", onclick: () => set({ theme: "blackberry", mode: "light", accent: null }) }, "↺ Reset"),
        el("button", { type: "button", class: "btn-sm", onclick: close }, "Done")),
    );
  }

  function previewTheme(id) {
    const saved = { ...state };
    Object.assign(state, { theme: id, accent: null });
    apply(true);
    Object.assign(state, saved);
  }

  function open() {
    panel = el("div", { class: "theme-panel", role: "dialog", "aria-modal": "false", "aria-labelledby": "theme-title" });
    if (fab.parentElement.classList.contains("theme-slot")) panel.classList.add("top");
    render();
    // Arrow keys move between options inside a group (standard radio-group behaviour).
    panel.addEventListener("keydown", (e) => {
      const r = e.target.closest?.("[role=radio]");
      if (!r || !["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(e.key)) return;
      e.preventDefault();
      const all = [...r.closest("[role=radiogroup]").querySelectorAll("[role=radio]")];
      const next = all[(all.indexOf(r) + (e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1) + all.length) % all.length];
      next.focus();
      next.click();
    });
    document.body.append(panel);
    fab.setAttribute("aria-expanded", "true");
    panel.querySelector('[aria-checked="true"]')?.focus();
    setTimeout(() => document.addEventListener("pointerdown", outside), 0);
  }
  function close() {
    if (!panel) return;
    panel.remove();
    panel = null;
    fab.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside);
    fab.focus();
  }
  const outside = (e) => { if (panel && !panel.contains(e.target) && !fab.contains(e.target)) close(); };

  function mount() {
    fab = el("button", { type: "button", class: "theme-fab", "aria-label": "Change theme", title: "Change theme", "aria-expanded": "false", "aria-haspopup": "dialog", onclick: () => (panel ? close() : open()) }, "🎨");
    const slot = document.querySelector(".theme-slot");
    (slot || document.body).append(fab);
    document.addEventListener("keydown", (e) => e.key === "Escape" && panel && close());
  }
  document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", mount) : mount();

  window.QuizlaneTheme = { THEMES, get: () => ({ ...state }), set };
})();
