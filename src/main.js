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

// ---- URL entry ------------------------------------------------------------
$("url-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const raw = $("url-input").value.trim();
  const url = normalizeUrl(raw);
  if (!url) return showEntryError("Please enter a valid URL.");
  load(url);
});

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

  // Persist the last URL for convenience.
  try {
    localStorage.setItem("wwwpdf:last", url);
  } catch {}

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

// ---- restore last URL into the input for quick reuse ----------------------
try {
  const last = localStorage.getItem("wwwpdf:last");
  if (last) $("url-input").value = last;
} catch {}
