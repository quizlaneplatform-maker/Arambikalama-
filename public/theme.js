// Theme switcher: preset palettes, light/dark/auto mode and a custom accent colour.
// Loaded in <head> so the saved theme is applied before the page paints (no flash).
(function () {
  // Game-show sets. night* = the stage (dark mode), day* = daytime rehearsal (light mode).
  const THEMES = {
    primetime: { name: "Prime time", night: ["#140a33", "#1f1248", "#2b1a60", "#3a2878", "#b6a9e0"], day: ["#f4f0ff", "#ffffff", "#ebe4fd", "#dcd2f5", "#5e5385"], accent: "#ff3d6e", gold: "#ffc93c" },
    latenight: { name: "Late night", night: ["#071a2e", "#0d2742", "#143457", "#1f4569", "#9fbbd6"], day: ["#eef4fa", "#ffffff", "#e0eaf4", "#cfdcea", "#4b6178"], accent: "#ff5a36", gold: "#ffd166" },
    studio: { name: "Studio red", night: ["#2a0a14", "#3b0f1e", "#4e1529", "#651d36", "#e2aab9"], day: ["#fff1f3", "#ffffff", "#fde3e8", "#f5ccd5", "#7a4452"], accent: "#ff3b3b", gold: "#ffd54a" },
    neon: { name: "Neon", night: ["#0b2622", "#12352f", "#19453d", "#23574d", "#9fd6c8"], day: ["#ecf8f5", "#ffffff", "#dcf1ec", "#c6e6de", "#46685f"], accent: "#ff4fd8", gold: "#e8ff5c" },
    arcade: { name: "Arcade", night: ["#1a0f3d", "#24155a", "#2f1d70", "#3e2a8a", "#bfb2f0"], day: ["#f1efff", "#ffffff", "#e5e0ff", "#d5cdfa", "#57509a"], accent: "#2bd9fe", gold: "#ff9f1c" },
    sunset: { name: "Sunset", night: ["#2b1240", "#3a1955", "#4a2169", "#5d2c80", "#d8b4e8"], day: ["#fbf0f6", "#ffffff", "#f5e1ee", "#ecd0e2", "#6e4766"], accent: "#ff7a1a", gold: "#ffd166" },
  };
  const ACCENTS = ["#ff3d6e", "#ff5a36", "#ff7a1a", "#2bd9fe", "#3a66f0", "#9b5cff", "#ff4fd8", "#2fbf71"];
  const KEY = "ql_theme";
  const root = document.documentElement;
  const darkQuery = matchMedia("(prefers-color-scheme: dark)");

  let state = { theme: "primetime", mode: "dark", accent: null };
  try { Object.assign(state, JSON.parse(localStorage.getItem(KEY) || "{}")); } catch {}
  // Old saved themes from the previous design fall back to the new default stage.
  if (!THEMES[state.theme]) Object.assign(state, { theme: "primetime", mode: "dark", accent: null });

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
    const [n1, n2, n3, nLine, nMuted] = t.night;
    const [d1, d2, d3, dLine, dMuted] = t.day;
    const vars = {
      "--night": n1, "--night-2": n2, "--night-3": n3, "--night-line": nLine, "--night-muted": nMuted,
      "--day": d1, "--day-2": d2, "--day-3": d3, "--day-line": dLine, "--day-muted": dMuted,
      "--accent": accent, "--accent-hover": mix(accent, "#ffffff", 0.25), "--accent-press": mix(accent, "#000000", 0.3),
      "--accent-ink": inkFor(accent, n1), "--gold": t.gold,
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
    if (meta) meta.content = n1;
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
              el("i", { style: `background:${th.night[0]}` }), el("i", { style: `background:${th.gold}` }), el("i", { style: `background:${th.accent}` }));
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
        el("button", { type: "button", class: "btn-ghost btn-sm", onclick: () => set({ theme: "primetime", mode: "dark", accent: null }) }, "↺ Reset"),
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

  window.AarambikallamaTheme = { THEMES, get: () => ({ ...state }), set };
})();
