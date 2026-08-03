# www → pdf

Capture a website, tidy it up, and save it as a clean PDF.

The native app is a **single window** (so it works on iOS, which forbids
multiple windows) with an in-page toolbar that progresses through panes. A
**Link · Edit · Format** breadcrumb in the toolbar header tracks the stage and
lets you jump straight back to any of them:

1. **Link** — type a URL, paste one with the clipboard button beside **Load**,
   or pick from your recent links (each shows the page's title once loaded).
   The one webview then navigates to the site in place. Clicking **Link** in
   the breadcrumb returns here.
2. **Edit** — log in if needed, then click elements to remove clutter (nav
   bars, cookie banners, ads…). An **archive.is mode** checkbox (above the ad
   blocker) reroutes the current article through archive.is for a paywall-free
   snapshot; after you clear its bot check, **Extract Content** lifts the
   snapshot's `#CONTENT` out and drops archive.is's own chrome so it edits like
   any other page. A built-in **ad blocker** (Bushido-style — EasyList cosmetic
   filters via Brave's adblock engine) hides known ad containers automatically;
   toggle it in the pane (archive.is mode disables it — hover the greyed-out
   toggle for why). Removal sets save as **presets**, re-applied on later
   visits or on other sites with the same layout (e.g. any Substack).
3. **Format** — "Next" flips the toolbar to formatting: body size, line height,
   heading scale, per-side margins (US Letter), a sans-serif metadata header
   (title, URL, author, publication, access date, notes), header/footer with optional
   page numbers, and a printer-style **page range** ("1-3, 5") that trims the
   output to just those pages. Entering Format renders the **real PDF and shows
   it inline** (drawn by pdf.js on a gray backdrop) — the actual paginated
   output, not an HTML approximation. "Refresh preview" re-renders after you
   adjust settings. The render itself happens **behind a cover** — the app
   shows a spinner and a progress line, never the webview reshaping itself —
   and the finished pages are what appears.
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
- **Paste from the clipboard.** The clipboard button beside **Load** fills the
  URL field; loading stays a separate click, so a stale clipboard can't send the
  app somewhere on one tap. The web build asks `navigator.clipboard.readText()`.
  The app can't count on it — that API is gated on a secure context, which the
  app's own custom scheme isn't — so it takes the same route as everything else
  here: a `wwwtopdf.paste`
  sentinel in, and Rust reads `NSPasteboard`/`UIPasteboard` and evals the text
  back through `__wwwpdfPasted`. Both routes run on a clock, because the
  interesting failure is silence: an OS paste prompt the user never answers
  leaves `readText()` pending forever rather than rejecting. Pasted text is
  normalised the way **Load** would (`example.com/x` → `https://example.com/x`,
  which the `type=url` field would otherwise reject), except when it contains
  whitespace — no URL does, and `new URL()` is forgiving enough to turn a
  sentence into `https://not%20a%20url/` — so prose lands in the field
  unchanged, and says so.
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
  edge via injected JS, (4) captures exact-width PDFs with
  `WKWebView.createPDF` — the whole view for short documents, **page-aligned
  segments** (`WKPDFConfiguration.rect`) past ~7,800 px, because Core
  Graphics clamps a single PDF page to 14,400 pt (the PDF 200-inch limit,
  ~22 US-Letter pages) and silently drops everything past it — and (5)
  slices the segments into US-Letter pages in pure Rust
  (`src-tauri/src/paginate.rs`, unit-tested — `cargo test`), snapping each
  page break to a measured **text-line boundary** (`Range.getClientRects()`
  gives one rect per rendered line, so cuts land between lines even inside
  paragraphs taller than a page; segment cuts land exactly on page
  boundaries, so a segment edge can never split a line either). The webview
  frame and toolbar are restored after capture.
- **The render is never on show.** Reshaping the live webview is what makes a
  faithful capture possible, but watching it happen looks like the app
  half-crashing: the page squeezes into a narrow column, the toolbar rides
  along with it, and the rest of the window is bare chrome. So an opaque
  **native cover** (an `NSView`/`UIView` with a system spinner and a status
  line, in the same gray as the preview backdrop) is laid over the webview's
  container for the whole export and lifted only when there's something
  finished to show. Its status line follows the phases — *Preparing the page →
  Capturing the page → Building the PDF* — and because it's a real view it also
  swallows clicks, so the frozen page can't be edited mid-capture. On a preview
  the cover is held past the render: Rust polls the editor's `__pvState` until
  pdf.js has actually painted the first page (bounded to ~5s), so the preview
  arrives complete rather than assembling itself on screen. Saving lifts it
  before the save dialog / share sheet, so the app looks normal behind them.
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
- **Identify content:** the Body / Line-height sliders resize a generic
  selector (`body, p, li, …`) by default, which misfires on div-based layouts.
  The **Identify content** section (Edit pane) reveals controls for **Header /
  Author / Date / Body**: Header and Body use **+ / −** (a signature LIST you
  grow and shrink — a signature is a tag + stable classes, a semantic text tag,
  or the tag plus its exact `style` attribute), while Author and Date are
  single-element **toggles** (one specific node, matched by a precise
  `cssPath`). Every match is tagged `NS-<cat>`; the Body sliders target
  `NS-body`, and each category gets a distinct confirmation wash shown only
  while editing (never in the PDF). On the way into Format:
  - inline `font-size` is stripped off the identified body **and its
    descendants** (nested spans were defeating the slider) so `NS-body`'s rule
    wins; and
  - if **Extract identified content** is on, the page's own markup is scrapped
    and rebuilt as a clean structure of just the identified header / author /
    date / body — each a cloned copy with all styling/classes stripped and
    **only the computed font re-applied** (body clones keep `NS-body` so the
    sliders drive them). Title/author/date form a centred, padded masthead; the
    body follows left-aligned. Originals are hidden and the page
    background/text colour neutralised so it reads on white paper. When this is
    on, the metadata header drops its own plain title so it isn't doubled with
    the styled one.

  Both effects apply to the live DOM the renderer captures and undo themselves
  on the way back to Edit. Picking an **Author** also fills the metadata Author
  field; on an archive.is snapshot the metadata URL is recovered as the original
  article (parsed from the snapshot URL, or stashed at submit time), not the
  archive address.
- **Page range:** a printer-style range from the Format pane (e.g. `1-3, 5`)
  rides the export sentinel and, after pagination, trims the PDF to just those
  pages before the header/footer stamp runs — so page numbers count the
  survivors. Pure Rust in `paginate.rs` (`parse_page_ranges` + `trim_to_range`,
  unit-tested): the paginated document is a single flat page tree, so trimming
  is a rebuild of its `Kids`. A blank or all-covering range is a no-op.
- **archive.is mode:** paywalled or framing-blocked articles can be routed
  through archive.is from the Edit pane. Rather than hand-craft a submit URL
  (archive.is is finicky about how the request is made), the editor drives the
  site's own form: checking the box navigates the webview to the archive.is
  home page, carrying the article URL in the location fragment; on arrival the
  editor fills that page's `#submiturl` form and clicks **save**, exactly as a
  person would, so archive.is runs its normal submit + bot-check flow. The
  webview also presents a real Safari user-agent (`WEBVIEW_UA`), without which
  archive.is serves embedded webviews an endless challenge. Once the user
  clears the bot check, the snapshot loads with the article inside a `#CONTENT`
  div, and **Extract Content** unwraps it — lifting `#CONTENT`'s children into
  `<body>` and discarding the wrapper (and its styling) along with the rest of
  the archive.is chrome, recovering the original URL for the metadata header.
  From there it's a normal edit → format → save.
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
- **Ad blocking and archive.is mode are exclusive.** A snapshot serves the
  article *and* archive.is's own chrome — bot check included — from the archive
  domain, so filters keyed to the live site land on the wrong markup and can
  hide the snapshot itself. So in archive.is mode the "Block ads" toggle is
  disabled and greyed out, reads *off · archive.is mode*, and explains itself on
  hover; the "↻ Refresh filters" link goes with it. It stands down the moment
  the box is ticked, not when the snapshot lands — fetching one takes a while
  and the old page (and its toolbar) stays on screen throughout. Un-ticking
  before the snapshot arrives gives it straight back. One rule decides it
  (`syncAdblockEnabled`), so an engine push mid-snapshot can't switch it back
  on, and an explicit "off" still outlives a filter update.
- **Session persistence (stay logged in):** the webview runs with a
  **non-persistent (incognito) data store** — on purpose: a persistent store
  makes WKWebView write a "WebCrypto Master Key" to the login keychain, which
  macOS then prompts to unlock on every launch (worse under dev builds, whose
  changing code signature invalidates the item each rebuild). A non-persistent
  store never creates it. Because nothing persists on its own, the app manages
  the two things it *wants* to keep, itself: it snapshots the cookie store to
  `cookies.json` (app data dir, `0600`) on every finished page load and on
  window close and pushes the saved cookies back into the store at startup
  before the first target page loads (session cookies included — that's what
  keeps a login alive), and it keeps the **recent list** in `history.json`
  (Rust records each entered URL and captured title, and pushes the list into
  the URL-entry page on load) rather than the webview's localStorage. So "log
  in once, capture articles on later runs" still behaves like a normal browser,
  with no keychain prompt. Auth material never leaves the device.
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
