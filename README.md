# www → pdf

Capture a website, tidy it up, and save it as a clean PDF.

The native app is a **single window** (so it works on iOS, which forbids
multiple windows) with an in-page toolbar that progresses through panes. A
**Link · Edit · Format** breadcrumb in the toolbar header tracks the stage and
lets you jump straight back to any of them:

1. **Link** — type a URL or pick from your recent links (each shows the page's
   title once loaded). The one webview then navigates to the site in place.
   Clicking **Link** in the breadcrumb returns here.
2. **Edit** — log in if needed, then click elements to remove clutter (nav
   bars, cookie banners, ads…). A built-in **ad blocker** (Bushido-style —
   EasyList cosmetic filters via Brave's adblock engine) hides known ad
   containers automatically; toggle it in the pane. Removal sets save as
   **presets**, re-applied on later visits or on other sites with the same
   layout (e.g. any Substack).
3. **Format** — "Next" flips the toolbar to formatting: body size, line height,
   heading scale, per-side margins (US Letter), a sans-serif metadata header
   (title, URL, author, access date, notes), and header/footer with optional
   page numbers. Entering Format renders the **real PDF and shows it inline**
   (drawn by pdf.js on a gray backdrop) — the actual paginated output, not an
   HTML approximation. "Refresh preview" re-renders after you adjust settings.
4. **Save** — writes the previewed PDF (save dialog on desktop, share sheet on
   iOS).

It ships as a **web app** (GitHub Pages) and a **native app** (Tauri 2, desktop + iOS).

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

### How the single-window native flow hangs together

Output is **US Letter (8.5 × 11 in)** with adjustable per-side margins.

- **One webview.** iOS forbids multiple windows, so there is a single window
  (created in `run()`'s `setup`) that starts on the bundled URL-entry page and
  navigates to target sites *in place* (`load_url`). The editor engine is an
  init script that runs on every page and mounts its toolbar on remote pages
  (it suppresses itself on our own page via `__WWWPDF_IS_APP`).
- **Responsive toolbar.** On tablets/desktop the toolbar is a floating card in
  the top-right corner. On a phone (viewport ≤ 480px, e.g. iPhone portrait)
  that card would eclipse the page/preview, so it docks as a full-width
  **bottom sheet** with an internal scroll, keeping the page (Edit) or the PDF
  preview (Format) visible above it. Safe-area insets (`env(safe-area-inset-*)`,
  enabled by appending `viewport-fit=cover` to the page's existing viewport
  meta) keep the primary action clear of the home indicator / notch.
- **Sentinel navigations, not IPC.** A remote page has no working Tauri IPC
  (ACL, [#10317](https://github.com/tauri-apps/tauri/issues/10317)), so the
  toolbar signals the app by navigating to a sentinel host the `on_navigation`
  hook cancels: `wwwtopdf.export?action=save|preview&…` (render), `wwwtopdf.home`
  (back to URL entry), `wwwtopdf.preset?action=…` (persist). Fonts/metadata are
  applied directly to the page DOM (so `createPDF` captures them); only margins,
  header/footer, page-numbers and the filename ride the export sentinel.
- **Inline preview with pdf.js.** Entering Format renders the real PDF and
  shows it *inside the page*: Rust injects a vendored pdf.js (UMD build +
  worker) into the target webview and streams the rendered PDF bytes over as
  chunked base64 (via `eval` + the editor's `__pv*` chunk protocol); the editor
  draws each page to a `<canvas>` in a full-screen overlay. Drawing to canvas
  (not `<embed>`/`<iframe>`) with the worker running on the **main thread** (a
  fake worker) means even a strict site CSP — `object-src 'none'`,
  `worker-src 'none'` — can't block the preview. Rendering on demand ("Refresh
  preview") avoids re-rendering on every keystroke. "Save" writes the same file
  (save dialog on desktop, share sheet on iOS).
- **Rendering = createPDF + Rust pagination** (shared by macOS and iOS). WKWebView's
  `printOperationWithPrintInfo:` derives its layout width and scale from the
  *printer's* imageable bounds (constant for save-to-PDF) while clipping to
  the user margins — so custom margins structurally cannot work there
  (established empirically; three experiments, all consistent). Instead the
  renderer (1) resizes the webview to the printable width so the live DOM
  truly reflows, (2) **settles** the page so lazy-loaded content materializes
  (below), (3) measures content height and every block element's bottom
  edge via injected JS, (4) captures one tall exact-width PDF with
  `WKWebView.createPDF`, and (5) slices it into US-Letter pages in pure Rust
  (`paginate_tall_pdf`, unit-tested by probe), snapping each page break to a
  measured **text-line boundary** (`Range.getClientRects()` gives one rect per
  rendered line, so cuts land between lines even inside paragraphs taller
  than a page). The webview frame and toolbar are restored after capture.
- **Settle (no truncation):** long articles render below the fold lazily
  (infinite scroll, `IntersectionObserver`-driven hydration, lazy images), so
  a height measured too early would capture a truncated PDF — the page looks
  complete in Edit but cuts off in the render. Before freezing, the renderer
  grows the webview frame to the current content height (which brings
  below-the-fold sections "into view" and fires their observers) and
  re-measures, repeating until the height stops changing and images finish —
  bounded to ~4s. Content height is read from `body.scrollHeight`, **not**
  `documentElement.scrollHeight`: the latter is `max(content, frameHeight)`,
  and since we deliberately grow the frame past the content, reading it back
  would just echo the frame and never converge.
- **Headers/footers/page numbers:** WebKit has no CSS running headers or
  `@page` counters, so they're stamped onto the finished PDF in Rust
  (`lopdf`) — drawn in the margin bands in 9pt Helvetica. Pure Rust, so the
  same code will serve iOS.
- **Removal presets:** each clicked removal records a durable CSS selector
  (nearest sane id, else `tag.stable-classes` path; build-hashed class names
  are skipped). The toolbar shows a dropdown (a preset auto-applies on
  select; "No Preset" is the neutral top entry) with an "Edit Presets" link
  that reveals Save new / Update selected / Delete. Presets live in
  `presets.json` in the app data dir; Rust injects them into the target
  webview alongside the editor (the remote page has no IPC to ask with), and
  save/update/delete arrive via the `wwwtopdf.preset` sentinel navigation,
  which evals the refreshed list back into the toolbar.
- **Removals stick (no resurrection):** ad-heavy pages resurrect "removed"
  containers constantly — a framework re-render or ad refresh replaces the
  node (fresh element, no class) or rewrites `className`/`style` wholesale,
  and the pre-capture reflow (the renderer resizes the webview) looks like a
  viewport change that ad slots refresh into. Three layers stop this.
  Removal hides with a class **plus an inline `display:none !important`**
  (anti-adblock CSS like `#ad{display:block!important}` outranks any class
  rule on specificity, but nothing in a stylesheet outranks an important
  inline declaration; Undo restores the prior inline value). A
  MutationObserver re-asserts every removal the moment the page mutates
  (re-adds wiped classes/styles, re-removes replaced nodes via the recorded
  selector, re-creates the style element if the page tears it out); observer
  callbacks are microtasks, which run before the next paint, so a resurrected
  ad can never reach the frame `createPDF` snapshots. And for the capture
  itself the renderer **freezes the page's JS and physically detaches every
  hidden element** (`__captureFreeze`): pending timeouts / intervals /
  animation frames are cancelled, the scheduling APIs are stubbed, and each
  hidden node is swapped for an inert same-tag placeholder — a node outside
  the DOM can't be resurrected by any style trick, while the placeholder
  keeps sibling-structure styling (`:nth-child`, adjacent-sibling rules) of
  the kept content from shifting. `__captureThaw` swaps the originals back
  and restores the APIs, so Undo still works after a preview. The web build
  does the same detach around `window.print()`.
- **Ad blocker (Bushido-style):** cosmetic filtering the way the
  [Bushido browser](https://github.com/visualstudioblyat/bushido) does it,
  built on Brave's MPL-2.0 [`adblock-rust`](https://github.com/brave/adblock-rust)
  engine (`src-tauri/src/bushido.rs`) — no GPL code is taken from Bushido
  itself. **EasyList** is downloaded at first run (not redistributed with the
  app), cached in the app data dir, and refreshed weekly. On each page load
  Rust harvests the page's class names/ids, asks the engine for the matching
  hide-selectors (URL-specific rules + generic rules keyed to the harvest,
  minus that site's `#@#`/`generichide` exceptions) and pushes them into the
  editor, which hides matches with plain CSS — so ads injected later die on
  arrival. The Edit pane has the "Block ads" toggle and a "↻ Refresh filters"
  link (the `wwwtopdf.adblock` sentinel) for ad units that load late. The web
  build — and a native first run while offline — falls back to a small
  built-in list of unambiguous ad selectors.
- **Session persistence (stay logged in):** WKWebView keeps a persistent
  website data store, but flushes cookies to disk on its own lazy schedule —
  log in, quit soon after, and the login is gone next launch. So the app
  snapshots the cookie store to `cookies.json` (app data dir, `0600`) on every
  finished page load and on window close, and pushes the saved cookies back
  into the store at startup before the first target page loads. Session
  cookies are kept too — restoring them is what keeps a login alive across
  restarts — so "log in once, capture articles on later runs" behaves like a
  normal browser. Auth material never leaves the device.
- **Stage 4 save:** a native save dialog (`tauri-plugin-dialog`); the chosen
  location receives a *copy of the previewed file*, so the saved PDF is
  byte-identical to what was on screen. On iOS the same button hands the file
  to the share sheet (`UIActivityViewController`).
- **Web build:** no programmatic PDF generation exists in-browser, so the
  in-page toolbar keeps all controls and `Save as PDF` calls `window.print()`
  with an injected `@page { size: 8.5in 11in; margin: … }` — the print dialog
  is the preview. Works in real browsers, including iPad Safari.

> The renderer is shared by macOS and iOS: `createPDF`, `evaluateJavaScript`,
> and `frame`/`setFrame:` all exist on both `NSView` and `UIView`, so the same
> `render_pdf` runs on both (the paginator/stamper is pure Rust). iOS save/
> preview go through the share sheet. **Not yet exercised on a device** — see
> the iOS testing notes below.

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
```

The native flow: enter a URL → Rust opens it in a real webview with the editor
injected ([`src-tauri/src/lib.rs`](src-tauri/src/lib.rs)) → edit → Save as PDF.

> Tauri needs the Rust toolchain and platform WebView libraries installed —
> see <https://tauri.app/start/prerequisites/>. The `icons/icon.png` in this
> repo is a plain placeholder; replace it with `npm run tauri icon`.

### iOS

```bash
# one-time prerequisites (macOS only)
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
xcode-select --install          # Xcode + command-line tools
sudo gem install cocoapods      # or: brew install cocoapods

npm run ios:init                # generates src-tauri/gen/apple/ (the Xcode project)
npm run ios:dev                 # run on a booted Simulator (easiest) or device
npm run build:ios               # release build / archive
```

The `ios` CLI subcommand only exists on macOS, so these run on your Mac. The
generated `src-tauri/gen/apple/` is git-ignored by default (regenerate with
`ios:init`); remove it from `.gitignore` if you want to commit native config
(Info.plist entries, signing). Device builds need a development team — set it
in Xcode (`gen/apple`) or as `bundle.iOS.developmentTeam` in `tauri.conf.json`.

> **iOS status — runs on device; being hardened.** The core flow (load, edit,
> inline pdf.js preview, render, share) works on iPhone and iPad. Device fixes
> applied so far: the webview fills the screen and tracks rotation/Stage-Manager
> resizes (`fit_webview_to_superview` pins it to its superview with a flexible
> autoresizing mask; `inner_size` is desktop-only); loads go through a native
> `webview.navigate()` (the `wwwtopdf.load` sentinel) rather than a JS location
> change, so a site with an installed app loads in-app instead of being hijacked
> by a Universal Link; the shared PDF is named after the page title; and the
> recent list shows page titles (Rust captures each visited page's title and
> relays it to the app page, which the target origin can't write itself). Still
> worth watching: the share sheet's popover
> anchoring on iPad, and whether the phone bottom-sheet's `env(safe-area-inset-*)`
> values resolve (they need a `viewport-fit=cover` viewport, which the editor
> appends only when the page already ships a viewport meta). Paste any build or
> runtime error and it's usually a small fix.

## Layout

```
index.html            entry + viewer screens
src/main.js           web controller: iframe load, cross-origin fallback, Tauri bridge
src/ui.css            app chrome
public/editor.js      the shared editing engine (iframe inject / native)
src-tauri/            Tauri 2 native app
src-tauri/src/bushido.rs  ad-block engine (EasyList via Brave's adblock-rust)
src-tauri/assets/     vendored pdf.js (UMD build + worker) for the inline preview
.github/workflows/    Pages deploy
```

## License

MIT
