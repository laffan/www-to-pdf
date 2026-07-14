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

// ---- boot: decide which screen this window shows ---------------------------
// The native preview window reuses this same index.html with label "preview".
// NOTE: called at the very end of this module — it must not run before the
// module-level consts below are initialized (TDZ).
async function boot() {
  if (isTauri) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    if (getCurrentWindow().label === "preview") {
      entry.hidden = true;
      initPreview();
      return;
    }
  }
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

// ---- load a URL into the viewer ------------------------------------------
let loadTimer = null;
function load(url) {
  $("entry-error").hidden = true;
  pushHistory(url);

  // Native app: hand the URL to Rust, which opens a webview with the editor
  // already injected. No iframe, no cross-origin limits.
  if (isTauri) {
    tauriInvoke("open_target", { url }).catch((e) =>
      showEntryError("Could not open page: " + e)
    );
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
  $("blocked-reason").textContent = reason;
  blocked.hidden = false;
}

// ---- viewer controls ------------------------------------------------------
$("back-btn").addEventListener("click", () => {
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

// ============ STAGE 3 (native): PDF settings + live preview ============
// Runs in the "preview" window. Drives three commands:
//   apply_settings  -> evals font/metadata changes into the target page
//   render_preview  -> renders the real PDF to a temp file (shown in iframe)
//   save_pdf        -> native save dialog (share sheet on iOS), copies preview
async function initPreview() {
  const { invoke, convertFileSrc } = await import("@tauri-apps/api/core");
  const screen = $("pdf-settings");
  screen.hidden = false;

  const frame = $("pv-frame");
  const status = $("pv-status");
  const loading = $("pv-loading");

  // Prefill metadata from the page we came from.
  let info = { title: "", url: "" };
  try {
    info = await invoke("get_page_info");
  } catch {}
  $("pv-title").value = info.title || "";
  $("pv-url").value = info.url || "";
  $("pv-date").value = new Date().toISOString().slice(0, 10);

  const val = (id) => $(id).value;
  const num = (id) => {
    const v = parseFloat($(id).value);
    return isNaN(v) ? 0 : Math.max(0, Math.min(3, v));
  };
  // IMPORTANT: margins ship in BOTH payloads. The page's @page CSS drives
  // WebKit's print *layout* width, while the native NSPrintInfo margins drive
  // tile *placement*. If they disagree, text reflows to the wrong width and
  // gets cropped — so the same values go to apply_settings (CSS) and
  // render_preview (native).
  const margins = () => ({
    top: num("pv-mt"),
    right: num("pv-mr"),
    bottom: num("pv-mb"),
    left: num("pv-ml"),
  });
  const settings = () => ({
    bodyPx: parseInt($("pv-body").value, 10),
    lineHeight: parseFloat($("pv-line").value),
    headingScale: parseFloat($("pv-head").value),
    margins: margins(),
    meta: {
      show: $("pv-meta-on").checked,
      title: val("pv-title"),
      url: val("pv-url"),
      author: val("pv-author"),
      accessDate: val("pv-date"),
      notes: val("pv-notes"),
    },
  });

  // Serialized refresh: never two renders in flight; a change during a render
  // queues exactly one follow-up.
  let rendering = false;
  let queued = false;
  async function refresh() {
    if (rendering) {
      queued = true;
      return;
    }
    rendering = true;
    loading.hidden = false;
    status.textContent = "";
    try {
      await invoke("apply_settings", { settings: settings() });
      const m = margins();
      const path = await invoke("render_preview", {
        mt: m.top,
        mr: m.right,
        mb: m.bottom,
        ml: m.left,
        header: val("pv-header") || null,
        footer: val("pv-footer") || null,
        pageNumbers: $("pv-pagenum").checked,
      });
      frame.src = convertFileSrc(path) + "?t=" + Date.now();
    } catch (e) {
      status.textContent = "Preview failed: " + e;
    } finally {
      loading.hidden = true;
      rendering = false;
      if (queued) {
        queued = false;
        refresh();
      }
    }
  }

  let debounceTimer = null;
  function scheduleRefresh() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(refresh, 400);
  }

  // Wire every control.
  $("pv-meta-on").addEventListener("change", () => {
    $("pv-meta-fields").hidden = !$("pv-meta-on").checked;
    scheduleRefresh();
  });
  for (const id of ["pv-title", "pv-url", "pv-author", "pv-date", "pv-notes"]) {
    $(id).addEventListener("input", scheduleRefresh);
  }
  $("pv-body").addEventListener("input", () => {
    $("pv-body-out").textContent = $("pv-body").value + "px";
    scheduleRefresh();
  });
  $("pv-line").addEventListener("input", () => {
    $("pv-line-out").textContent = parseFloat($("pv-line").value).toFixed(2);
    scheduleRefresh();
  });
  $("pv-head").addEventListener("input", () => {
    $("pv-head-out").textContent =
      Math.round(parseFloat($("pv-head").value) * 100) + "%";
    scheduleRefresh();
  });
  for (const id of ["pv-mt", "pv-mr", "pv-mb", "pv-ml", "pv-header", "pv-footer"]) {
    $(id).addEventListener("input", scheduleRefresh);
  }
  $("pv-pagenum").addEventListener("change", scheduleRefresh);

  // Stage 4: save.
  $("pv-save").addEventListener("click", async () => {
    status.textContent = "";
    try {
      const saved = await invoke("save_pdf", {
        suggested: val("pv-title") || "page",
      });
      status.textContent = saved ? "Saved → " + saved : "Cancelled.";
    } catch (e) {
      status.textContent = "Save failed: " + e;
    }
  });

  // Initial render.
  refresh();
}

// Everything above is initialized — safe to boot.
boot();
