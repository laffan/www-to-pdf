/*
 * www-to-pdf — web app controller
 * Wires the URL-entry screen to the viewer, tries to inject the shared editor
 * engine into the loaded iframe, and directs the user to the native app when
 * the browser's same-origin policy forbids editing the framed page.
 */

// The editor engine is served as a static asset (see /public/editor.js).
// Vite rewrites BASE_URL for GitHub Pages project sites (e.g. /www-to-pdf/).
const BASE = import.meta.env.BASE_URL;
const EDITOR_URL = new URL(BASE + "editor.js", location.href).href;

const $ = (id) => document.getElementById(id);
const entry = $("entry");
const viewer = $("viewer");
const frame = $("frame");
const blocked = $("blocked");

// In the Tauri app we open the target in a real native webview (which can load
// and edit any origin) rather than an iframe. `__TAURI_INTERNALS__` is present
// in every Tauri webview regardless of the `withGlobalTauri` setting, so it's
// the reliable signal — `window.__TAURI__` is NOT injected by default in v2.
const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
async function tauriInvoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

// ---- boot -------------------------------------------------------------------
// Single window: this page is always the URL-entry screen. In the app it also
// navigates in place to target sites, where the injected editor takes over.
function boot() {
  renderHistory();
}

// ---- URL entry ------------------------------------------------------------
$("url-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const raw = $("url-input").value.trim();
  const url = normalizeUrl(raw);
  if (!url) return showEntryError("Please enter a valid URL.");
  load(url);
});

// ---- history (stage 1) ------------------------------------------------------
// Entries are { u: url, t: title }. The title arrives later than the URL (once
// the page has loaded and reported document.title), so it's filled in by
// setHistoryTitle — from the editor on the web build, or from Rust at the
// stage-2→3 hand-off in the app.
const HISTORY_KEY = "wwwpdf:history";
function readHistory() {
  try {
    const h = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    if (!Array.isArray(h)) return [];
    // Migrate the old plain-string format.
    return h.map((e) => (typeof e === "string" ? { u: e, t: "" } : e)).filter((e) => e && e.u);
  } catch {
    return [];
  }
}
function writeHistory(h) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(0, 8)));
  } catch {}
}
function pushHistory(url) {
  const existing = readHistory().find((e) => e.u === url);
  const entry = { u: url, t: existing ? existing.t : "" };
  writeHistory([entry, ...readHistory().filter((e) => e.u !== url)]);
  renderHistory();
}
function setHistoryTitle(url, title) {
  title = (title || "").trim();
  if (!title) return;
  const h = readHistory();
  const e = h.find((x) => x.u === url);
  if (!e || e.t === title) return;
  e.t = title;
  writeHistory(h);
  renderHistory();
}
// Called from Rust (app) via eval on the main window.
window.__wwwpdfSetHistoryTitle = setHistoryTitle;

function renderHistory() {
  const list = $("history");
  if (!list) return;
  list.textContent = "";
  for (const { u, t } of readHistory()) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = "#";
    a.title = u;
    if (t) {
      const title = document.createElement("span");
      title.className = "h-title";
      title.textContent = t;
      const url = document.createElement("span");
      url.className = "h-url";
      url.textContent = u;
      a.append(title, url);
    } else {
      a.textContent = u;
    }
    a.addEventListener("click", (e) => {
      e.preventDefault();
      $("url-input").value = u;
      load(u);
    });
    li.appendChild(a);
    list.appendChild(li);
  }
}

function normalizeUrl(raw) {
  if (!raw) return null;
  let s = raw;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try {
    return new URL(s).href;
  } catch {
    return null;
  }
}
function showEntryError(msg) {
  const e = $("entry-error");
  e.textContent = msg;
  e.hidden = false;
}

// ---- loading indicator ------------------------------------------------------
function showLoading(url) {
  const bar = $("load-bar");
  if (bar) bar.hidden = false;
  const st = $("entry-status");
  if (st) {
    let host = url;
    try { host = new URL(url).host; } catch {}
    st.textContent = "Loading " + host + "…";
    st.hidden = false;
  }
}
function hideLoading() {
  const bar = $("load-bar");
  if (bar) bar.hidden = true;
  const st = $("entry-status");
  if (st) st.hidden = true;
}

// ---- load a URL into the viewer ------------------------------------------
let loadTimer = null;
function load(url) {
  $("entry-error").hidden = true;
  pushHistory(url);
  showLoading(url);

  // Native app: navigate this single webview to the page in place. Use a
  // plain top-level navigation — the same mechanism the editor's sentinels
  // use, so it's known to work here — rather than a Rust command. The editor
  // init-script takes over on the loaded page. Rust captures the app page as
  // "home" (see on_page_load) so "New URL" can return. The bar stays up until
  // the webview swaps in the freshly loaded document (this page unloads).
  if (isTauri) {
    window.location.assign(url);
    return;
  }

  $("viewer-url").textContent = url;
  entry.hidden = true;
  viewer.hidden = false;
  blocked.hidden = true;

  // If the frame neither loads nor errors quickly, the site almost certainly
  // refused embedding (X-Frame-Options / CSP). Surface the fallback.
  clearTimeout(loadTimer);
  loadTimer = setTimeout(() => showBlocked(
    "The site refused to be displayed in a frame (X-Frame-Options or CSP)."
  ), 4000);

  frame.onload = onFrameLoad;
  frame.src = url;
}

function onFrameLoad() {
  clearTimeout(loadTimer);
  hideLoading();
  // Try to reach into the frame. Cross-origin access throws — that's our
  // signal that in-frame editing is impossible and we should point the user
  // to the native app.
  let doc = null;
  try {
    doc = frame.contentDocument || frame.contentWindow.document;
    // Touch a property to force the security check.
    void doc.body;
  } catch {
    showBlocked(
      "The page loaded, but it's on a different origin so its content can't be edited from here (same-origin policy)."
    );
    return;
  }
  if (!doc || !doc.body) {
    showBlocked("The page could not be read for editing.");
    return;
  }
  injectEditor(doc);
}

function injectEditor(doc) {
  blocked.hidden = true;
  // Same-origin frame: we can read the real page title for the history list.
  setHistoryTitle($("viewer-url").textContent, doc.title || "");
  if (doc.getElementById("wwwpdf-loader")) return; // already injected
  const s = doc.createElement("script");
  s.id = "wwwpdf-loader";
  s.src = EDITOR_URL;
  s.onload = () => {
    const w = frame.contentWindow;
    if (w.wwwToPdf) {
      // Pre-fill metadata from what we know about the page.
      w.wwwToPdf.mount({
        meta: {
          url: $("viewer-url").textContent,
          title: doc.title || "",
          accessDate: new Date().toISOString().slice(0, 10),
        },
      });
    }
  };
  doc.body.appendChild(s);
}

function showBlocked(reason) {
  clearTimeout(loadTimer);
  hideLoading();
  $("blocked-reason").textContent = reason;
  blocked.hidden = false;
}

// ---- viewer controls ------------------------------------------------------
$("back-btn").addEventListener("click", () => {
  hideLoading();
  viewer.hidden = true;
  entry.hidden = false;
  frame.src = "about:blank";
});

$("print-btn").addEventListener("click", () => {
  // Editing happens inside the frame, so print the frame's own window when we
  // can reach it; otherwise there's nothing framed to print.
  try {
    const w = frame.contentWindow;
    void w.document.body; // throws if cross-origin
    w.focus();
    w.print();
  } catch {
    showBlocked(
      "This page is cross-origin and can't be printed from here. Use the desktop or iOS app to capture it."
    );
  }
});

$("open-tab").addEventListener("click", () => {
  const url = $("viewer-url").textContent;
  if (url) window.open(url, "_blank", "noopener");
});


// Everything above is initialized — safe to boot.
boot();
