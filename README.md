# www → pdf

Capture a website, tidy it up, and save it as a clean PDF.

The native app is a **single window** (so it works on iOS, which forbids
multiple windows) with an in-page toolbar that progresses through panes:

1. **URL entry** — type or pick from your recent links. The one webview then
   navigates to the site in place.
2. **Edit** — log in if needed, then click elements to remove clutter (nav
   bars, cookie banners, ads…). Removal sets save as **presets**, re-applied on
   later visits or on other sites with the same layout (e.g. any Substack).
3. **Format** — "Next" flips the toolbar to formatting: body size, line height,
   heading scale, per-side margins (US Letter), a sans-serif metadata header
   (title, URL, author, access date, notes), and header/footer with optional
   page numbers — all applied live to the page.
4. **Preview / Save** — Preview renders the real PDF and opens it in the OS
   viewer (share sheet on iOS); Save writes it (save dialog on desktop, share
   sheet on iOS). "New URL" returns to step 1.

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
- **Sentinel navigations, not IPC.** A remote page has no working Tauri IPC
  (ACL, [#10317](https://github.com/tauri-apps/tauri/issues/10317)), so the
  toolbar signals the app by navigating to a sentinel host the `on_navigation`
  hook cancels: `wwwtopdf.export?action=save|preview&…` (render), `wwwtopdf.home`
  (back to URL entry), `wwwtopdf.preset?action=…` (persist). Fonts/metadata are
  applied directly to the page DOM (so `createPDF` captures them); only margins,
  header/footer, page-numbers and the filename ride the export sentinel.
- **Preview vs. save.** A strict site CSP can block an embedded PDF, so there's
  no in-page preview pane; instead "Preview" renders the real PDF and opens it
  in the OS viewer (Quick Look on macOS, share sheet on iOS), and "Save" writes
  it (save dialog on desktop, share sheet on iOS). Rendering on demand also
  avoids re-rendering on every keystroke.
- **Rendering = createPDF + Rust pagination** (shared by macOS and iOS). WKWebView's
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
  are skipped). The toolbar shows a dropdown (a preset auto-applies on
  select; "No Preset" is the neutral top entry) with an "Edit Presets" link
  that reveals Save new / Update selected / Delete. Presets live in
  `presets.json` in the app data dir; Rust injects them into the target
  webview alongside the editor (the remote page has no IPC to ask with), and
  save/update/delete arrive via the `wwwtopdf.preset` sentinel navigation,
  which evals the refreshed list back into the toolbar.
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

> **iOS status — architected for it, not yet verified on a device.** Both
> former blockers are addressed: the app is now single-window (a pane
> progression, no `target`/`preview` windows), and the renderer is shared by
> macOS and iOS. What remains is on-device reality-checking, since none of the
> Apple code can be compiled off a Mac. Likely first things to shake out:
> whether `setFrame:` on the iOS `WKWebView` sticks (it may fight the view
> controller's layout), the share sheet's popover anchoring on iPad, and the
> file paths (`$TEMP`) matching the asset-protocol scope. Paste any build or
> runtime error and it's usually a small fix.

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
