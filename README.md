# www → pdf

Capture a website, tidy it up, and save it as a clean PDF.

The native app is a four-stage flow:

1. **URL entry** — type or pick from your recent links.
2. **Page editing** — the site opens in a real webview: log in if needed, then
   click elements to remove clutter (nav bars, cookie banners, ads…). Removal
   sets can be saved as **presets** and re-applied on later visits — or on
   other sites with the same layout (e.g. any Substack).
3. **PDF settings** — a second window shows a live preview that is the *actual
   generated PDF*, with controls for body size, line height, heading scale,
   per-side margins (US Letter output), a sans-serif metadata header (title,
   URL, author, access date, notes), and header/footer text with optional
   page numbers.
4. **Save** — a native save dialog on desktop; the share sheet on iOS.

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

### How the native staged flow hangs together

Output is **US Letter (8.5 × 11 in)** with adjustable per-side margins.

- **Stage 2 → 3 hand-off:** app-command IPC from a dynamically-created *remote*
  webview is denied by Tauri's ACL
  ([#10317](https://github.com/tauri-apps/tauri/issues/10317)), so the injected
  toolbar's "Next" navigates to a sentinel URL (`https://wwwtopdf.stage3/?…`);
  Rust's `on_navigation` hook cancels the navigation (the edited page is
  untouched) and opens the PDF-settings window.
- **Stage 3 preview:** the settings window is *local* UI, so it uses normal
  IPC. Each change is `eval`'d into the target page (fonts/metadata must live
  in the page DOM to appear in the render), then the page is rendered to a
  temp PDF shown via the asset protocol. What you see is the real paginated
  PDF.
- **Rendering = createPDF + Rust pagination.** WKWebView's
  `printOperationWithPrintInfo:` derives its layout width and scale from the
  *printer's* imageable bounds (constant for save-to-PDF) while clipping to
  the user margins — so custom margins structurally cannot work there
  (established empirically; three experiments, all consistent). Instead the
  renderer (1) resizes the webview to the printable width so the live DOM
  truly reflows, (2) measures content height and every block element's bottom
  edge via injected JS, (3) captures one tall exact-width PDF with
  `WKWebView.createPDF`, and (4) slices it into US-Letter pages in pure Rust
  (`paginate_tall_pdf`, unit-tested by probe), snapping each page break to a
  measured **text-line boundary** (`Range.getClientRects()` gives one rect per
  rendered line, so cuts land between lines even inside paragraphs taller
  than a page). The webview frame and toolbar are restored after capture.
- **Headers/footers/page numbers:** WebKit has no CSS running headers or
  `@page` counters, so they're stamped onto the finished PDF in Rust
  (`lopdf`) — drawn in the margin bands in 9pt Helvetica. Pure Rust, so the
  same code will serve iOS.
- **Removal presets:** each clicked removal records a durable CSS selector
  (nearest sane id, else `tag.stable-classes` path; build-hashed class names
  are skipped). Presets live in `presets.json` in the app data dir; Rust
  injects them into the target webview alongside the editor (the remote page
  has no IPC to ask with), and saves/deletes arrive via the
  `wwwtopdf.preset` sentinel navigation, which evals the refreshed list back
  into the toolbar.
- **Stage 4 save:** a native save dialog (`tauri-plugin-dialog`); the chosen
  location receives a *copy of the previewed file*, so the saved PDF is
  byte-identical to what was on screen. On iOS the same button hands the file
  to the share sheet (`UIActivityViewController`).
- **Web build:** no programmatic PDF generation exists in-browser, so the
  in-page toolbar keeps all controls and `Save as PDF` calls `window.print()`
  with an injected `@page { size: 8.5in 11in; margin: … }` — the print dialog
  is the preview. Works in real browsers, including iPad Safari.

> **Rendering is macOS-only for now** — the iOS renderer (via
> `UIPrintPageRenderer`) is a TODO; the share-sheet plumbing is already in
> place. The app otherwise runs on iOS.

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
