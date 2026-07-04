# www → pdf

Capture a website, tidy it up, and save it as a clean PDF.

Load a page, then use an in-page toolbar to:

- **Log in** if the site needs it
- **Remove elements** (nav bars, cookie banners, ads, footers…) by clicking them
- **Tune type** — body text size and heading scale
- **Add a metadata header** (title, URL, author, access date, notes)
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
is delivered three ways:

| Delivery | Where it runs | Works on | How it's loaded |
| --- | --- | --- | --- |
| **Bookmarklet** | The real page in your browser | **Any** site (already logged in) | You click it on the page |
| **Iframe inject** | An embedded frame | Same-origin / framable sites only | Web app injects it |
| **Tauri webview** | A native webview | **Any** site | Injected as an init script |

The web app tries the iframe first and, when the browser blocks it, points you
at the bookmarklet — which is the honest zero-backend way to get the full
feature set on arbitrary, logged-in sites. The native app has no iframe limits
at all.

`Save as PDF` calls `window.print()`, so you get the browser/OS print dialog and
pick **Save as PDF** (desktop) or share → PDF (iOS). This preserves the page's
real layout and fonts far better than rasterizing to a canvas.

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
public/editor.js      the shared editing engine (bookmarklet / iframe / native)
src-tauri/            Tauri 2 native app
.github/workflows/    Pages deploy
```

## License

MIT
