# www → pdf

Capture a website, tidy it up, and save it as a clean PDF.

Load a page, then use an in-page toolbar to:

- **Log in** if the site needs it
- **Remove elements** (nav bars, cookie banners, ads, footers…) by clicking them
- **Tune type** — body text size and heading scale
- **Add a metadata header** (title, URL, author, access date, notes)
- **Set page margins** — US Letter output with per-side margins
- **Save as PDF**

It ships as a **web app** (GitHub Pages) and a **native app** (Tauri 2, desktop + iOS/Android).

---

## Why the architecture is the way it is

The interesting constraint: **a static site cannot load an _arbitrary_ website
in a frame and edit it.** Browsers stop this two ways:

1. Most sites send `X-Frame-Options` / CSP `frame-ancestors`, which forbids
   framing them at all.
2. Even a framable site is a _different origin_, so the same-origin policy
   forbids the surrounding page from reading or changing its DOM — no removing
   elements, no font changes, no scoping it for print.

Tools that convert any URL to PDF server-side get around this with headless
Chrome (Puppeteer/Playwright). GitHub Pages has no server, so that's off the
table here.

The fix is to run the editor **inside the target page's own context**, where
the DOM is fair game. One shared engine ([`public/editor.js`](public/editor.js))
is delivered two ways:

| Delivery | Where it runs | Works on | How it's loaded |
| --- | --- | --- | --- |
| **Iframe inject** | An embedded frame | Same-origin / framable sites only | Web app injects it |
| **Tauri webview** | A native webview | **Any** site, including logged-in | Injected as an init script |

The web (GitHub Pages) build works for same-origin and framable pages. Anything
that blocks framing or needs a login can only be captured in the **native app**,
whose webview has no cross-origin limit — that's the app's reason to exist.

### Saving the PDF

Output is **US Letter (8.5 × 11 in)** with adjustable margins (set per-side in
the toolbar; toggle "Show margin guide" to preview the printable area).

- **Web build:** `Save as PDF` calls `window.print()` with an injected
  `@page { size: 8.5in 11in; margin: … }`, so the browser paginates to real
  Letter sheets. You pick "Save as PDF" in the print dialog. Works in real
  browsers, including iPad Safari.
- **Native app:** `window.print()` is unreliable in WKWebView, and app-command
  IPC from a dynamically-created *remote* webview is denied by Tauri's ACL
  ([#10317](https://github.com/tauri-apps/tauri/issues/10317)). So the editor
  signals the app by navigating to a sentinel URL
  (`https://wwwtopdf.export/?…`); Rust's `on_navigation` hook cancels that
  navigation (the edited page is untouched) and renders the webview through
  **AppKit's print pipeline** (`printOperationWithPrintInfo:`, a silent
  save-to-PDF job) with the chosen Letter paper size and margins. The saved
  path is reported back into the toolbar's toast via script injection (which,
  unlike IPC, works on any origin). Saved to Downloads.

> Because the trigger is a navigation (not an IPC command), no remote-IPC
> capability is needed and loaded pages get no access to app commands.
> **macOS only for now** — iOS export (via `UIPrintPageRenderer`) is a TODO;
> the app otherwise runs on iOS.

---

## Develop

```bash
npm install
npm run dev        # web app at http://localhost:5173
```

### The editor engine

[`public/editor.js`](public/editor.js) is a dependency-free IIFE that mounts a
floating toolbar and exposes `window.wwwToPdf.mount()` / `.unmount()`. It's the
single source of truth for all three delivery methods — edit it once, every
surface updates.

## Build & deploy the web app (GitHub Pages)

```bash
npm run build      # -> dist/
```

Deployment is automatic: [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)
builds and publishes `dist/` to Pages on every push to `main`. Enable it once in
**Settings → Pages → Source → GitHub Actions**. The workflow sets
`BASE_PATH=/<repo>/` so asset paths are correct for a project site.

## Build the native app (Tauri 2)

```bash
# one-time: generate real app icons from a source image
npm run tauri icon path/to/icon.png

# desktop
npm run app:dev
npm run app:build

# iOS (needs macOS + Xcode)
npm run tauri ios init
npm run tauri ios dev

# Android (needs Android SDK/NDK)
npm run tauri android init
npm run tauri android dev
```

The native flow: enter a URL → Rust opens it in a real webview with the editor
injected ([`src-tauri/src/lib.rs`](src-tauri/src/lib.rs)) → edit → Save as PDF.

> Tauri needs the Rust toolchain and platform WebView libraries installed —
> see <https://tauri.app/start/prerequisites/>. The `icons/icon.png` in this
> repo is a plain placeholder; replace it with `npm run tauri icon`.

## Layout

```
index.html            entry + viewer screens
src/main.js           web controller: iframe load, cross-origin fallback, Tauri bridge
src/ui.css            app chrome
public/editor.js      the shared editing engine (iframe inject / native)
src-tauri/            Tauri 2 native app
.github/workflows/    Pages deploy
```

## License

MIT
