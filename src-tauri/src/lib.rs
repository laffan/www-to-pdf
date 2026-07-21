// www-to-pdf — native app entry point (Tauri 2)
//
// SINGLE WINDOW, PANE PROGRESSION (works on desktop AND iOS, which forbids
// multiple windows). There is one webview:
//   1. it starts on the bundled URL-entry page (index.html);
//   2. the URL-entry page navigates that same webview to the target site (a
//      plain location.href change), where the editor init-script mounts an
//      in-page toolbar (Pane 1: remove/presets →
//      Pane 2: fonts/metadata/margins/header-footer);
//   3. the toolbar's Preview/Save/New-URL/preset actions are sentinel
//      navigations the on_navigation hook cancels and turns into native work
//      (render this webview, save/share, or go home). Sentinels are used
//      because the remote page has no working Tauri IPC.
//
// The renderer (createPDF + Rust pagination + stamping) is shared by macOS and
// iOS; save is a dialog on desktop and the share sheet on iOS.

use std::sync::Mutex;
use tauri::{Manager, Url, WebviewUrl, WebviewWindowBuilder};

mod bushido;
mod paginate;
use paginate::Margins;
#[cfg(any(target_os = "macos", target_os = "ios"))]
use paginate::Meas;

// The shared editor engine, embedded so the native build is self-contained.
const EDITOR_JS: &str = include_str!("../../public/editor.js");

// pdf.js (UMD build + its worker), vendored from pdfjs-dist. Injected into the
// target webview on demand to render the inline PDF preview. Embedded only on
// the Apple targets that have a native PDF renderer to preview. Kept as classic
// scripts (window.pdfjsLib / window.pdfjsWorker) so they run on any page; the
// worker is used as a main-thread fake worker, so a strict site CSP that
// forbids Web Workers can't block preview rendering.
#[cfg(any(target_os = "macos", target_os = "ios"))]
const PDF_JS_LIB: &str = include_str!("../assets/pdf.min.js");
#[cfg(any(target_os = "macos", target_os = "ios"))]
const PDF_JS_WORKER: &str = include_str!("../assets/pdf.worker.min.js");

// Sentinel hosts the editor navigates to; see editor.js.
const EXPORT_HOST: &str = "wwwtopdf.export"; // ?action=save|preview&margins…
const HOME_HOST: &str = "wwwtopdf.home"; // back to URL entry
const PRESET_HOST: &str = "wwwtopdf.preset"; // ?action=save|update|delete…
const LOAD_HOST: &str = "wwwtopdf.load"; // ?url=… -> native WKWebView load
const ADBLOCK_HOST: &str = "wwwtopdf.adblock"; // ?action=refresh -> recompute ad filters

// A real Safari user-agent for the webview. WKWebView's default UA omits the
// "Version/x Safari/x" tokens, so it reads as a bare embedded WebKit client —
// which sites like archive.today treat hostilely, serving an endless challenge
// or a blank page that never resolves (it loads fine in Safari with the same
// URL). Presenting a standard Safari UA makes remote sites serve us the normal
// experience. Desktop UA on macOS, mobile Safari UA on iOS.
#[cfg(not(target_os = "ios"))]
const WEBVIEW_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
#[cfg(target_os = "ios")]
const WEBVIEW_UA: &str = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";

/// A saved removal set: CSS selectors recorded when elements were clicked,
/// replayable on any page with similar markup. Stored in the app data dir;
/// injected into the target webview alongside the editor at load time.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct Preset {
    id: String,
    name: String,
    host: String,
    selectors: Vec<String>,
}

fn presets_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("presets.json"))
}

fn load_presets(app: &tauri::AppHandle) -> Vec<Preset> {
    presets_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn store_presets(app: &tauri::AppHandle, presets: &[Preset]) {
    if let Some(p) = presets_path(app) {
        if let Ok(json) = serde_json::to_string_pretty(presets) {
            let _ = std::fs::write(p, json);
        }
    }
}

/// Presets as a JS expression (valid JSON is valid JS, modulo U+2028/9).
fn presets_json_for_js(presets: &[Preset]) -> String {
    serde_json::to_string(presets)
        .unwrap_or_else(|_| "[]".into())
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

/// Handle a preset save/delete sentinel navigation, then push the updated
/// list (and a toast) back into the toolbar via eval.
fn handle_preset_nav(app: &tauri::AppHandle, url: &Url) {
    let get = |k: &str| -> Option<String> {
        url.query_pairs()
            .find(|(q, _)| q == k)
            .map(|(_, v)| v.into_owned())
    };
    let mut presets = load_presets(app);
    let msg = match get("action").as_deref() {
        Some("save") => {
            let selectors: Vec<String> = get("sels")
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default();
            if selectors.is_empty() {
                "Preset had no selectors".to_string()
            } else {
                let name = get("name").unwrap_or_else(|| "Preset".into());
                let host = get("host").unwrap_or_default();
                let id = format!(
                    "p{}",
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis())
                        .unwrap_or(0)
                );
                let n = selectors.len();
                presets.push(Preset {
                    id,
                    name: name.clone(),
                    host,
                    selectors,
                });
                store_presets(app, &presets);
                format!("Saved preset “{name}” ({n} selectors)")
            }
        }
        Some("update") => {
            let id = get("id").unwrap_or_default();
            let selectors: Vec<String> = get("sels")
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default();
            match presets.iter_mut().find(|p| p.id == id) {
                Some(preset) if !selectors.is_empty() => {
                    let n = selectors.len();
                    preset.selectors = selectors;
                    let name = preset.name.clone();
                    store_presets(app, &presets);
                    format!("Updated “{name}” ({n} selectors)")
                }
                Some(_) => "Update had no selectors".to_string(),
                None => "Preset not found".to_string(),
            }
        }
        Some("delete") => match get("id") {
            Some(id) => {
                presets.retain(|p| p.id != id);
                store_presets(app, &presets);
                "Preset deleted".to_string()
            }
            None => "Missing preset id".to_string(),
        },
        _ => return,
    };
    if let Some(w) = app.get_webview_window("main") {
        let json = presets_json_for_js(&presets);
        let msg_js = serde_json::to_string(&msg).unwrap_or_else(|_| "\"\"".into());
        let _ = w.eval(&format!(
            "window.wwwToPdf&&(window.wwwToPdf.presetsUpdated&&window.wwwToPdf.presetsUpdated({json}),window.wwwToPdf.toast&&window.wwwToPdf.toast({msg_js}))"
        ));
    }
}

#[derive(Default)]
struct AppState {
    // The URL-entry page to return to when the user picks "New URL".
    home: Mutex<Option<Url>>,
    // The URL string most recently asked to load (verbatim from the entry
    // screen). Used to key a captured page title to the same recent-list entry.
    pending: Mutex<Option<String>>,
    // Captured page titles, keyed by that entry URL, pushed into the app page's
    // recent list when it next loads (the target page is a different origin, so
    // it can't write the app's localStorage itself).
    titles: Mutex<std::collections::HashMap<String, String>>,
    // The Bushido-style ad-block engine. Built once, in the background, at app
    // start (EasyList parse takes a beat); None until then and when the list
    // can neither be read from cache nor downloaded.
    adblock: Mutex<Option<bushido::AdBlocker>>,
}

/// Where the rendered PDF lives before saving/sharing. Must stay inside the
/// asset-protocol scope declared in tauri.conf.json ($TEMP/**).
fn preview_path() -> std::path::PathBuf {
    std::env::temp_dir().join("wwwtopdf-preview.pdf")
}

fn non_empty(s: String) -> Option<String> {
    let t = s.trim();
    if t.is_empty() { None } else { Some(t.to_string()) }
}

/// Report a render outcome back into the in-page editor's toast.
fn report(app: &tauri::AppHandle, ok: bool, msg: &str) {
    if let Some(w) = app.get_webview_window("main") {
        let m = serde_json::to_string(msg).unwrap_or_else(|_| "\"\"".into());
        let _ = w.eval(&format!(
            "window.wwwToPdf&&window.wwwToPdf.afterExport&&window.wwwToPdf.afterExport({ok},{m})"
        ));
    }
}

/// Navigate back to the URL-entry page. Uses a page-driven `location.href`
/// change (the same proven mechanism the sentinels use) rather than the
/// native `navigate` API.
fn go_home(app: &tauri::AppHandle) {
    let home = app.state::<AppState>().home.lock().unwrap().clone();
    if let (Some(webview), Some(u)) = (app.get_webview_window("main"), home) {
        let target = serde_json::to_string(u.as_str()).unwrap_or_else(|_| "\"/\"".into());
        let _ = webview.eval(&format!("window.location.href = {target}"));
    }
}

/// on_navigation hook: intercept sentinel navigations. Returns true if this was
/// a sentinel (so the navigation should be cancelled), false to allow it.
fn handle_sentinel(app: &tauri::AppHandle, nav_url: &Url) -> bool {
    match nav_url.host_str() {
        Some(EXPORT_HOST) => {
            let app = app.clone();
            let url = nav_url.clone();
            tauri::async_runtime::spawn(async move { do_export(app, url).await });
            true
        }
        Some(HOME_HOST) => {
            go_home(app);
            true
        }
        Some(PRESET_HOST) => {
            let app = app.clone();
            let url = nav_url.clone();
            tauri::async_runtime::spawn(async move { handle_preset_nav(&app, &url) });
            true
        }
        Some(ADBLOCK_HOST) => {
            // "↻ Refresh filters": recompute the cosmetic filter set for the
            // page as it is NOW (late-loading ads bring classes/ids the first
            // harvest missed).
            let app = app.clone();
            tauri::async_runtime::spawn(async move { push_adblock_selectors(&app).await });
            true
        }
        Some(LOAD_HOST) => {
            // Load the target with a NATIVE webview load (WKWebView.load), not a
            // JS location change. Apple only opens Universal Links for user link
            // activations, never for a host-initiated load — so this avoids the
            // "an installed app (Substack, …) grabs the URL and the webview
            // hangs" hijack. Remember the entered URL to key the page title.
            if let Some(target) = nav_url
                .query_pairs()
                .find(|(k, _)| k == "url")
                .map(|(_, v)| v.into_owned())
            {
                *app.state::<AppState>().pending.lock().unwrap() = Some(target.clone());
                if let Ok(u) = Url::parse(&target) {
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Some(mut w) = app.get_webview_window("main") {
                            let _ = w.navigate(u);
                        }
                    });
                }
            }
            true
        }
        _ => false,
    }
}

/// Push every captured page title into the app page's recent list. The target
/// pages are foreign origins, so they can't touch the app's localStorage — Rust
/// relays the titles when the app (URL-entry) page is (re)loaded.
fn push_history_titles(app: &tauri::AppHandle) {
    let titles = app.state::<AppState>().titles.lock().unwrap().clone();
    if titles.is_empty() {
        return;
    }
    if let Some(w) = app.get_webview_window("main") {
        for (u, t) in titles {
            let uj = serde_json::to_string(&u).unwrap_or_else(|_| "\"\"".into());
            let tj = serde_json::to_string(&t).unwrap_or_else(|_| "\"\"".into());
            let _ = w.eval(&format!(
                "window.__wwwpdfSetHistoryTitle&&window.__wwwpdfSetHistoryTitle({uj},{tj})"
            ));
        }
    }
}

/// Capture the just-loaded target page's document.title, keyed to the entry URL
/// that requested it, for the recent list. Apple-only (needs a JS eval that
/// returns a value); a no-op elsewhere.
#[cfg(any(target_os = "macos", target_os = "ios"))]
fn capture_history_title(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let key = app.state::<AppState>().pending.lock().unwrap().clone();
        let Some(key) = key else { return };
        if let Some(w) = app.get_webview_window("main") {
            if let Ok(title) = eval_js_string(&w, "document.title").await {
                let t = title.trim().to_string();
                if !t.is_empty() {
                    app.state::<AppState>()
                        .titles
                        .lock()
                        .unwrap()
                        .insert(key, t);
                }
            }
        }
    });
}
#[cfg(not(any(target_os = "macos", target_os = "ios")))]
fn capture_history_title(_app: &tauri::AppHandle) {}

// ---- Bushido ad blocking: per-page cosmetic filters -------------------------
// Generic EasyList rules are keyed to class names / ids, so the page is asked
// what it actually contains (like uBlock's cosmetic survey); the engine then
// returns only the selectors that matter here. Capped so a pathological page
// can't produce an unbounded payload.
#[cfg(any(target_os = "macos", target_os = "ios"))]
const ADBLOCK_HARVEST_JS: &str = r#"(function(){
  try{
    var cs={},ids={},els=document.querySelectorAll('[class],[id]');
    for(var i=0;i<els.length&&i<20000;i++){var e=els[i];
      if(e.id)ids[e.id]=1;
      var cl=e.classList;if(cl)for(var j=0;j<cl.length;j++)cs[cl[j]]=1;}
    return JSON.stringify({c:Object.keys(cs).slice(0,8000),i:Object.keys(ids).slice(0,8000)});
  }catch(err){return '{"c":[],"i":[]}'}
})()"#;

#[cfg(any(target_os = "macos", target_os = "ios"))]
#[derive(serde::Deserialize, Default)]
struct Harvest {
    #[serde(default)]
    c: Vec<String>,
    #[serde(default)]
    i: Vec<String>,
}

/// Compute the hide-selector set for the currently loaded page and hand it to
/// the in-page editor (which owns the on/off toggle and the actual hiding).
#[cfg(any(target_os = "macos", target_os = "ios"))]
async fn push_adblock_selectors(app: &tauri::AppHandle) {
    let Some(webview) = app.get_webview_window("main") else {
        return;
    };
    let url = eval_js_string(&webview, "location.href")
        .await
        .unwrap_or_default();
    if !url.starts_with("http") {
        return; // our own app page, or nothing loaded yet
    }
    let harvest: Harvest = eval_js_string(&webview, ADBLOCK_HARVEST_JS)
        .await
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let state = app.state::<AppState>();
    let selectors = {
        let guard = state.adblock.lock().unwrap();
        let Some(blocker) = guard.as_ref() else {
            return; // engine still building, or no list available
        };
        blocker.selectors_for(&url, &harvest.c, &harvest.i)
    };
    if selectors.is_empty() {
        return; // keep the editor's built-in fallback
    }
    let Ok(json) = serde_json::to_string(&selectors) else {
        return;
    };
    let json = json.replace('\u{2028}', "\\u2028").replace('\u{2029}', "\\u2029");
    // Stash on the window as well: if the push wins the race with the editor's
    // mount, mount picks it up from there.
    let _ = webview.eval(&format!(
        "window.__WWWPDF_ADBLOCK={json};window.wwwToPdf&&window.wwwToPdf.setAdblockSelectors&&window.wwwToPdf.setAdblockSelectors(window.__WWWPDF_ADBLOCK)"
    ));
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
async fn push_adblock_selectors(_app: &tauri::AppHandle) {}

// ---- session persistence: cookies -------------------------------------------
// WKWebView's website data store is persistent, but it flushes cookies to
// disk lazily on its own schedule — log in, quit soon after, and the login is
// gone on the next launch. Persist them explicitly, like most WKWebView apps
// do: every finished page load (and the window-close request) snapshots the
// cookie store to cookies.json in the app data dir; startup pushes the saved
// cookies back into the store before the first target page loads. That's what
// makes "log in once, capture articles on later runs" behave like a browser.
// Session cookies (no expiry) are saved too, deliberately: restoring them is
// exactly what keeps a site's login alive across app restarts.

#[cfg(any(target_os = "macos", target_os = "ios"))]
#[derive(serde::Serialize, serde::Deserialize)]
struct StoredCookie {
    name: String,
    value: String,
    domain: String,
    path: String,
    /// unix seconds; None = session cookie
    expires: Option<f64>,
    secure: bool,
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn cookies_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("cookies.json"))
}

/// Snapshot every cookie in the webview's WKHTTPCookieStore to disk.
#[cfg(any(target_os = "macos", target_os = "ios"))]
fn save_cookies(app: &tauri::AppHandle) {
    use block2::RcBlock;
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    let Some(path) = cookies_path(app) else { return };
    let Some(webview) = app.get_webview_window("main") else { return };
    let _ = webview.with_webview(move |platform| unsafe {
        let wk = platform.inner() as *mut AnyObject;
        if wk.is_null() {
            return;
        }
        let config: *mut AnyObject = msg_send![wk, configuration];
        let store: *mut AnyObject = msg_send![config, websiteDataStore];
        let cookie_store: *mut AnyObject = msg_send![store, httpCookieStore];
        if cookie_store.is_null() {
            return;
        }
        let block = RcBlock::new(move |cookies: *mut AnyObject| {
            if cookies.is_null() {
                return;
            }
            let read_str = |obj: *mut AnyObject| -> String {
                if obj.is_null() {
                    return String::new();
                }
                let utf8: *const std::os::raw::c_char = msg_send![obj, UTF8String];
                if utf8.is_null() {
                    String::new()
                } else {
                    std::ffi::CStr::from_ptr(utf8).to_string_lossy().into_owned()
                }
            };
            let count: usize = msg_send![cookies, count];
            let mut out: Vec<StoredCookie> = Vec::with_capacity(count);
            for i in 0..count {
                let c: *mut AnyObject = msg_send![cookies, objectAtIndex: i];
                if c.is_null() {
                    continue;
                }
                let name: *mut AnyObject = msg_send![c, name];
                let value: *mut AnyObject = msg_send![c, value];
                let domain: *mut AnyObject = msg_send![c, domain];
                let cpath: *mut AnyObject = msg_send![c, path];
                let expires_date: *mut AnyObject = msg_send![c, expiresDate];
                let expires = if expires_date.is_null() {
                    None
                } else {
                    let secs: f64 = msg_send![expires_date, timeIntervalSince1970];
                    Some(secs)
                };
                let secure: bool = msg_send![c, isSecure];
                let name = read_str(name);
                if name.is_empty() {
                    continue;
                }
                out.push(StoredCookie {
                    name,
                    value: read_str(value),
                    domain: read_str(domain),
                    path: read_str(cpath),
                    expires,
                    secure,
                });
            }
            if let Ok(json) = serde_json::to_string(&out) {
                if std::fs::write(&path, json).is_ok() {
                    // Auth material: keep it owner-readable only.
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        let _ = std::fs::set_permissions(
                            &path,
                            std::fs::Permissions::from_mode(0o600),
                        );
                    }
                }
            }
        });
        let _: () = msg_send![cookie_store, getAllCookies: &*block];
    });
}

/// Push the saved cookies back into the webview's cookie store (startup,
/// before the first target page loads). Expired ones are dropped here.
#[cfg(any(target_os = "macos", target_os = "ios"))]
fn restore_cookies(app: &tauri::AppHandle) {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};

    let Some(path) = cookies_path(app) else { return };
    let Ok(text) = std::fs::read_to_string(&path) else { return };
    let Ok(saved) = serde_json::from_str::<Vec<StoredCookie>>(&text) else { return };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);
    let saved: Vec<StoredCookie> = saved
        .into_iter()
        .filter(|c| !c.name.is_empty() && c.expires.map_or(true, |e| e > now))
        .collect();
    if saved.is_empty() {
        return;
    }
    let Some(webview) = app.get_webview_window("main") else { return };
    let _ = webview.with_webview(move |platform| unsafe {
        let wk = platform.inner() as *mut AnyObject;
        if wk.is_null() {
            return;
        }
        let config: *mut AnyObject = msg_send![wk, configuration];
        let store: *mut AnyObject = msg_send![config, websiteDataStore];
        let cookie_store: *mut AnyObject = msg_send![store, httpCookieStore];
        if cookie_store.is_null() {
            return;
        }
        let ns = |s: &str| -> *mut AnyObject {
            let c = std::ffi::CString::new(s).unwrap_or_default();
            msg_send![class!(NSString), stringWithUTF8String: c.as_ptr()]
        };
        for ck in &saved {
            // NSHTTPCookie property-list keys ("Name", "Value", …) are the
            // documented plist form of NSHTTPCookieName etc.
            let props: *mut AnyObject = msg_send![class!(NSMutableDictionary), dictionary];
            let set = |k: &str, v: *mut AnyObject| {
                if v.is_null() {
                    return;
                }
                let key = ns(k);
                let _: () = msg_send![props, setObject: v, forKey: key];
            };
            set("Name", ns(&ck.name));
            set("Value", ns(&ck.value));
            set("Domain", ns(&ck.domain));
            set("Path", ns(if ck.path.is_empty() { "/" } else { &ck.path }));
            if ck.secure {
                set("Secure", ns("TRUE"));
            }
            if let Some(exp) = ck.expires {
                let date: *mut AnyObject =
                    msg_send![class!(NSDate), dateWithTimeIntervalSince1970: exp];
                set("Expires", date);
            }
            let cookie: *mut AnyObject = msg_send![class!(NSHTTPCookie), cookieWithProperties: props];
            if cookie.is_null() {
                continue;
            }
            let _: () = msg_send![
                cookie_store,
                setCookie: cookie,
                completionHandler: std::ptr::null_mut::<AnyObject>()
            ];
        }
    });
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
fn save_cookies(_app: &tauri::AppHandle) {}
#[cfg(not(any(target_os = "macos", target_os = "ios")))]
fn restore_cookies(_app: &tauri::AppHandle) {}

/// Render the current webview to the preview PDF, then save or preview it.
async fn do_export(app: tauri::AppHandle, url: Url) {
    let get = |key: &str| -> String {
        url.query_pairs()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.into_owned())
            .unwrap_or_default()
    };
    let num = |key: &str| get(key).parse::<f64>().unwrap_or(1.0).clamp(0.0, 3.0);
    let m = Margins {
        top: num("mt"),
        right: num("mr"),
        bottom: num("mb"),
        left: num("ml"),
    };
    let header = non_empty(get("header"));
    let footer = non_empty(get("footer"));
    let page_numbers = get("pagenum") == "1";
    let range = get("range");
    let action = get("action");
    let title = get("title");

    let out = preview_path();
    let out_str = out.to_string_lossy().into_owned();

    let render = async {
        let webview = app
            .get_webview_window("main")
            .ok_or_else(|| "main window missing".to_string())?;
        render_pdf(&webview, &m, &out_str).await?;
        // Trim to the requested page range BEFORE stamping so page numbers
        // count the pages that actually survive into the output.
        paginate::trim_to_range(&out_str, &range)?;
        stamp_header_footer(&out_str, &m, header.as_deref(), footer.as_deref(), page_numbers)?;
        Ok::<(), String>(())
    }
    .await;

    if let Err(e) = render {
        report(&app, false, &e);
        return;
    }

    if action == "preview" {
        // Stream the rendered PDF into the in-page pdf.js overlay. On success
        // the overlay is the feedback, so there's no toast; only errors report.
        if let Err(e) = present_inline_preview(&app, &out_str).await {
            report(&app, false, &e);
        }
        return;
    }

    match present_save(&app, &out_str, &title).await {
        Ok(Some(path)) => report(&app, true, &format!("Saved → {path}")),
        Ok(None) => report(&app, true, "Done"),
        Err(e) => report(&app, false, &e),
    }
}

/// Base64-encode (standard alphabet, padded) for handing PDF bytes to the
/// webview's `atob`. Hand-rolled to avoid a new dependency.
#[cfg(any(target_os = "macos", target_os = "ios"))]
fn base64_encode(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { T[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    out
}

// ---- header/footer stamping (pure Rust, all platforms) ---------------------
// WebKit has no support for CSS running headers or @page counters, so page
// furniture is stamped onto the finished PDF instead. Text is drawn in the
// margin bands with a standard Helvetica Type1 font.

/// Escape text for a PDF literal string and map it to WinAnsi-safe bytes.
fn pdf_escape(s: &str) -> Vec<u8> {
    let mut out = Vec::new();
    for ch in s.chars() {
        let b: u8 = match ch {
            '(' | ')' | '\\' => {
                out.push(b'\\');
                ch as u8
            }
            c if (c as u32) < 128 => c as u8,
            // Common typographic characters -> WinAnsi codepoints.
            '\u{2018}' => 0x91,
            '\u{2019}' => 0x92,
            '\u{201C}' => 0x93,
            '\u{201D}' => 0x94,
            '\u{2013}' => 0x96,
            '\u{2014}' => 0x97,
            '\u{00A9}' => 0xA9,
            c if (c as u32) < 256 => c as u8, // Latin-1 == WinAnsi for most
            _ => b'?',
        };
        out.push(b);
    }
    out
}

/// Stamp header/footer/page numbers into the margins of every page.
fn stamp_header_footer(
    path: &str,
    m: &Margins,
    header: Option<&str>,
    footer: Option<&str>,
    page_numbers: bool,
) -> Result<(), String> {
    use lopdf::{dictionary, Document, Object, Stream};

    if header.is_none() && footer.is_none() && !page_numbers {
        return Ok(());
    }
    let mut doc = Document::load(path).map_err(|e| format!("stamp: load: {e}"))?;
    let pages = doc.get_pages();
    let total = pages.len();

    // One shared Helvetica font object for all stamps.
    let font_id = doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Helvetica",
        "Encoding" => "WinAnsiEncoding",
    });

    const PT_PER_IN: f64 = 72.0;
    let (lm, rm) = (m.left * PT_PER_IN, m.right * PT_PER_IN);
    let (tm, bm) = (m.top * PT_PER_IN, m.bottom * PT_PER_IN);
    const SIZE: f64 = 9.0;

    let page_ids: Vec<_> = pages.into_iter().collect();
    for (idx, (_no, page_id)) in page_ids.into_iter().enumerate() {
        // Page dimensions from MediaBox (fall back to US Letter).
        let (pw, ph) = {
            let dict = doc.get_dictionary(page_id).map_err(|e| e.to_string())?;
            match dict.get(b"MediaBox").and_then(|o| o.as_array()) {
                Ok(mb) if mb.len() == 4 => {
                    let f = |o: &Object| o.as_float().unwrap_or(0.0) as f64;
                    (f(&mb[2]) - f(&mb[0]), f(&mb[3]) - f(&mb[1]))
                }
                _ => (612.0, 792.0),
            }
        };

        add_stamp_font(&mut doc, page_id, font_id)?;

        // Positions sit midway into the margin bands; clamped so zero margins
        // still land on the page.
        let header_y = (ph - tm * 0.55 - SIZE * 0.4).min(ph - SIZE).max(SIZE);
        let footer_y = (bm * 0.45 - SIZE * 0.4).max(6.0);
        let mut ops: Vec<u8> = b"\nQ q 0.35 0.35 0.35 rg\n".to_vec();
        let text_at = |x: f64, y: f64, s: &str, ops: &mut Vec<u8>| {
            ops.extend_from_slice(b"BT /wwwPdfHF ");
            ops.extend_from_slice(format!("{SIZE} Tf {x:.1} {y:.1} Td (").as_bytes());
            ops.extend_from_slice(&pdf_escape(s));
            ops.extend_from_slice(b") Tj ET\n");
        };
        if let Some(h) = header {
            text_at(lm, header_y, h, &mut ops);
        }
        if let Some(f) = footer {
            text_at(lm, footer_y, f, &mut ops);
        }
        if page_numbers {
            let label = format!("{} / {}", idx + 1, total);
            // Right-align approximately (Helvetica avg glyph ~0.5 em).
            let est = label.len() as f64 * SIZE * 0.5;
            text_at(pw - rm - est, footer_y, &label, &mut ops);
        }
        ops.extend_from_slice(b"Q\n");

        // Sandwich the existing content: prepend "q" (so any unbalanced state
        // the page leaves behind is restored by our leading Q), then append
        // the stamp ops in a clean graphics state.
        let pre_id = doc.add_object(Stream::new(dictionary! {}, b"q\n".to_vec()));
        let post_id = doc.add_object(Stream::new(dictionary! {}, ops));
        let page_dict = doc.get_dictionary_mut(page_id).map_err(|e| e.to_string())?;
        let contents = page_dict.get(b"Contents").cloned();
        let new_contents = match contents {
            Ok(Object::Array(mut arr)) => {
                arr.insert(0, Object::Reference(pre_id));
                arr.push(Object::Reference(post_id));
                Object::Array(arr)
            }
            // Any other form (single reference, or a direct stream object) is
            // preserved in the middle of the sandwich.
            Ok(single) => Object::Array(vec![
                Object::Reference(pre_id),
                single,
                Object::Reference(post_id),
            ]),
            Err(_) => Object::Array(vec![Object::Reference(pre_id), Object::Reference(post_id)]),
        };
        page_dict.set("Contents", new_contents);
    }

    doc.save(path).map_err(|e| format!("stamp: save: {e}"))?;
    Ok(())
}

/// Put `font_id` into the page's Resources/Font dict under /wwwPdfHF,
/// handling direct, referenced, or missing Resources.
fn add_stamp_font(
    doc: &mut lopdf::Document,
    page_id: lopdf::ObjectId,
    font_id: lopdf::ObjectId,
) -> Result<(), String> {
    use lopdf::Object;

    fn set_font(res: &mut lopdf::Dictionary, font_id: lopdf::ObjectId) {
        let mut fonts = match res.get(b"Font") {
            Ok(Object::Dictionary(d)) => d.clone(),
            _ => lopdf::Dictionary::new(),
        };
        fonts.set("wwwPdfHF", Object::Reference(font_id));
        res.set("Font", Object::Dictionary(fonts));
    }

    let res_entry = doc
        .get_dictionary(page_id)
        .map_err(|e| e.to_string())?
        .get(b"Resources")
        .cloned();
    match res_entry {
        Ok(Object::Reference(res_id)) => {
            let res = doc.get_dictionary_mut(res_id).map_err(|e| e.to_string())?;
            set_font(res, font_id);
        }
        Ok(Object::Dictionary(mut res)) => {
            set_font(&mut res, font_id);
            doc.get_dictionary_mut(page_id)
                .map_err(|e| e.to_string())?
                .set("Resources", Object::Dictionary(res));
        }
        _ => {
            // No per-page Resources (may be inherited) — create one with just
            // our font. WebKit always writes per-page Resources; safety net.
            let mut res = lopdf::Dictionary::new();
            set_font(&mut res, font_id);
            doc.get_dictionary_mut(page_id)
                .map_err(|e| e.to_string())?
                .set("Resources", Object::Dictionary(res));
        }
    }
    Ok(())
}

// ---- presenting the rendered PDF (save / preview) --------------------------
// Desktop: Save opens a native save dialog and copies the preview file;
// Preview opens it in the OS PDF viewer. iOS: both go through the share sheet
// (which offers preview + save-to-Files). Returns Some(path) on save, None
// otherwise (cancelled / handed to the OS).

/// Save: native dialog on desktop, share sheet on iOS.
async fn present_save(
    app: &tauri::AppHandle,
    src: &str,
    suggested: &str,
) -> Result<Option<String>, String> {
    if !std::path::Path::new(src).exists() {
        return Err("No rendered PDF to save.".into());
    }
    #[cfg(target_os = "ios")]
    {
        // The share sheet / "Save to Files" names the file after its basename,
        // so hand it a copy named for the page title rather than the internal
        // "wwwtopdf-preview" scratch file. Stay inside the $TEMP asset scope.
        let dest = std::env::temp_dir().join(format!("{}.pdf", sanitize(suggested)));
        let share_path = match std::fs::copy(src, &dest) {
            Ok(_) => dest.to_string_lossy().into_owned(),
            Err(_) => src.to_string(), // fall back to the scratch file
        };
        ios_share(app, &share_path)?;
        return Ok(None);
    }
    #[cfg(not(target_os = "ios"))]
    {
        use tauri_plugin_dialog::DialogExt;
        let (tx, rx) = tokio::sync::oneshot::channel();
        app.dialog()
            .file()
            .add_filter("PDF", &["pdf"])
            .set_file_name(format!("{}.pdf", sanitize(suggested)))
            .save_file(move |picked| {
                let _ = tx.send(picked);
            });
        let picked = rx.await.map_err(|_| "save dialog closed unexpectedly".to_string())?;
        match picked {
            Some(file_path) => {
                let dest = file_path.into_path().map_err(|e| e.to_string())?;
                std::fs::copy(src, &dest).map_err(|e| format!("Could not write PDF: {e}"))?;
                Ok(Some(dest.to_string_lossy().into_owned()))
            }
            None => Ok(None),
        }
    }
}

/// Preview: stream the rendered PDF into the in-page pdf.js overlay. pdf.js is
/// injected into the target webview on first use (the fake worker keeps it
/// CSP-safe), then the PDF bytes are sent over as chunked base64 via the
/// editor's `__pv*` chunk protocol. Works the same on macOS and iOS — the
/// preview is drawn to <canvas> inside the page, no OS viewer / share sheet.
#[cfg(any(target_os = "macos", target_os = "ios"))]
async fn present_inline_preview(app: &tauri::AppHandle, src: &str) -> Result<(), String> {
    if !std::path::Path::new(src).exists() {
        return Err("No rendered PDF to preview.".into());
    }
    let webview = app
        .get_webview_window("main")
        .ok_or_else(|| "main window missing".to_string())?;
    let bytes = std::fs::read(src).map_err(|e| format!("read preview: {e}"))?;
    let b64 = base64_encode(&bytes);

    // Inject pdf.js once per loaded page. evaluateJavaScript runs on any origin
    // (bypasses page CSP), and the vendored worker registers window.pdfjsWorker
    // for a main-thread fake worker, so no worker-src is needed.
    let present = eval_js_string(&webview, "(typeof window.pdfjsLib)")
        .await
        .unwrap_or_default();
    if present.trim() != "object" {
        webview.eval(PDF_JS_LIB).map_err(|e| e.to_string())?;
        webview.eval(PDF_JS_WORKER).map_err(|e| e.to_string())?;
    }

    // Hand the bytes to the overlay in base64 chunks so no single
    // evaluateJavaScript payload is enormous. Evals run in submission order.
    webview
        .eval("window.wwwToPdf&&window.wwwToPdf.__pvBegin&&window.wwwToPdf.__pvBegin()")
        .map_err(|e| e.to_string())?;
    const CHUNK: usize = 512 * 1024;
    let mut i = 0;
    while i < b64.len() {
        let end = (i + CHUNK).min(b64.len());
        let piece = &b64[i..end]; // base64 is ASCII, so byte slicing is safe
        let js = format!(
            "window.wwwToPdf.__pvChunk({})",
            serde_json::to_string(piece).unwrap_or_else(|_| "\"\"".into())
        );
        webview.eval(&js).map_err(|e| e.to_string())?;
        i = end;
    }
    webview
        .eval("window.wwwToPdf.__pvEnd()")
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
async fn present_inline_preview(_app: &tauri::AppHandle, _src: &str) -> Result<(), String> {
    Err("Preview is only implemented on macOS and iOS.".into())
}

/// iOS share sheet (UIActivityViewController) anchored on the webview.
#[cfg(target_os = "ios")]
fn ios_share(app: &tauri::AppHandle, src: &str) -> Result<(), String> {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};

    let webview = app
        .get_webview_window("main")
        .ok_or_else(|| "main window missing".to_string())?;
    let path = src.to_string();
    webview
        .with_webview(move |platform| unsafe {
            let vc = platform.view_controller() as *mut AnyObject;
            let view = platform.inner() as *mut AnyObject; // WKWebView is a UIView
            if vc.is_null() {
                return;
            }
            let c = std::ffi::CString::new(path.as_str()).unwrap_or_default();
            let ns_path: *mut AnyObject =
                msg_send![class!(NSString), stringWithUTF8String: c.as_ptr()];
            let file_url: *mut AnyObject = msg_send![class!(NSURL), fileURLWithPath: ns_path];
            let items: *mut AnyObject = msg_send![class!(NSArray), arrayWithObject: file_url];
            let avc: *mut AnyObject = msg_send![class!(UIActivityViewController), alloc];
            let avc: *mut AnyObject = msg_send![
                avc,
                initWithActivityItems: items,
                applicationActivities: std::ptr::null_mut::<AnyObject>()
            ];
            let popover: *mut AnyObject = msg_send![avc, popoverPresentationController];
            if !popover.is_null() && !view.is_null() {
                let _: () = msg_send![popover, setSourceView: view];
            }
            let _: () = msg_send![
                vc,
                presentViewController: avc,
                animated: true,
                completion: std::ptr::null_mut::<AnyObject>()
            ];
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn sanitize(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let trimmed = cleaned.trim_matches('-');
    if trimmed.is_empty() {
        "page".to_string()
    } else {
        trimmed.chars().take(60).collect()
    }
}

// ---- macOS: createPDF + Rust pagination (US Letter, margins, no clipping) --
//
// WHY NOT printOperationWithPrintInfo: three experiments established that its
// layout width and scale derive from NSPrintInfo.imageablePageBounds — the
// PRINTER's printable area, which for save-to-PDF is the full sheet and thus
// CONSTANT — while clipping follows the user margins. Layout can never track a
// margin change, so custom margins structurally cannot work in that API.
//
// This pipeline controls layout directly instead:
//   1. resize the WKWebView to the printable width (CSS px = inches * 96) so
//      the live DOM genuinely reflows;
//   2. SETTLE (page JS still live): grow the frame to the content height and
//      re-measure until the height stabilizes and images finish, so
//      lazy-rendered content below the fold materializes instead of being
//      truncated; the editor's enforcement layer polices ads throughout;
//   3. injected JS freezes the page's JS, hides the tool chrome and measures
//      content height plus the bottom edge of every block element (safe
//      page-break candidates);
//   4. WKWebView.createPDF captures the document — whole-view for short
//      pages, page-aligned SEGMENTS (WKPDFConfiguration.rect) past ~7,800 px,
//      because Core Graphics clamps a single PDF page to 14,400 pt and
//      silently drops content past ~22 US-Letter pages;
//   5. paginate::paginate_segments (pure Rust, unit-tested in paginate.rs)
//      slices the segments into US-Letter pages at the user's margins,
//      snapping breaks to measured line bottoms so no text line is ever split;
//   6. the webview frame and chrome are restored (and the page thawed).
// The same createPDF/evaluateJavaScript calls exist on iOS, so this path is
// mobile-ready.

// Core Graphics geometry, hand-encoded to avoid the objc2-foundation
// feature-flag chain.
#[cfg(any(target_os = "macos", target_os = "ios"))]
mod geom {
    use objc2::encode::{Encode, Encoding};
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct CGPoint {
        pub x: f64,
        pub y: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct CGSize {
        pub width: f64,
        pub height: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct CGRect {
        pub origin: CGPoint,
        pub size: CGSize,
    }
    unsafe impl Encode for CGPoint {
        const ENCODING: Encoding = Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
    }
    unsafe impl Encode for CGSize {
        const ENCODING: Encoding = Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
    }
    unsafe impl Encode for CGRect {
        const ENCODING: Encoding =
            Encoding::Struct("CGRect", &[CGPoint::ENCODING, CGSize::ENCODING]);
    }
}

/// Runs inside the target page right before capture: hides the toolbar/toast/
/// margin-guide (createPDF renders SCREEN media, so @media print rules don't
/// apply here) and measures the document + safe break points.
/// Break candidates are per text LINE, not per block: Range.getClientRects()
/// yields one rect per rendered line fragment, so the paginator always has a
/// safe cut within one line-height of the ideal — even inside paragraphs
/// taller than a page. Line cuts sit at box-bottom + 1px (inside the next
/// line's top leading) so descenders that overpaint the box edge survive.
const CAPTURE_PREP_JS: &str = r#"(function(){
  try{
    // Freeze the page's own JS first (idempotent): re-assert every removal,
    // cancel pending timers/animation frames, and stub the scheduling APIs so
    // ad scripts can't re-inject anything between here and createPDF.
    if(window.wwwToPdf&&window.wwwToPdf.__captureFreeze)window.wwwToPdf.__captureFreeze();
    var st=document.getElementById('wwwpdf-capture');
    if(!st){st=document.createElement('style');st.id='wwwpdf-capture';
      // Hide ALL of the tool's own chrome so createPDF captures only the page.
      // #wwwpdf-preview is the full-screen inline-preview overlay: it is open
      // (covering the page) when a Format-stage render fires, so if it isn't
      // hidden the capture is just the overlay's flat grey — the "grey boxes"
      // bug. The metadata header (#wwwpdf-meta) is intentionally NOT hidden.
      st.textContent='#wwwpdf-panel,#wwwpdf-toast,#wwwpdf-preview{display:none!important}html::after{display:none!important}';
      document.documentElement.appendChild(st);}
    var d=document,b=d.body,e=d.documentElement;
    // Content height from <body>, not documentElement: the settle phase has
    // already grown the frame past the content, and documentElement.scrollHeight
    // is max(content, frameHeight) — it would echo the frame, not the page.
    var h=Math.max(b?b.scrollHeight:0,b?b.offsetHeight:0);
    if(h<1)h=Math.max(e.scrollHeight,e.offsetHeight);
    var sy=window.scrollY||0;
    var pts=[];
    // Replaced/atomic content: bottoms are safe cuts.
    var els=d.querySelectorAll('img,figure,table,video,canvas,svg,pre,tr,li');
    for(var i=0;i<els.length&&i<8000;i++){var r=els[i].getBoundingClientRect();
      if(r.height)pts.push(Math.round(r.bottom+sy));}
    // Every text line box bottom.
    var csCache=new Map();
    function usable(p){
      if(csCache.has(p))return csCache.get(p);
      var cs=window.getComputedStyle(p);
      var v=cs.position!=='fixed'&&cs.display!=='none'&&cs.visibility!=='hidden';
      csCache.set(p,v);return v;
    }
    var walker=d.createTreeWalker(b||e,NodeFilter.SHOW_TEXT,null);
    var range=d.createRange(),node,count=0;
    while((node=walker.nextNode())&&count<20000){
      if(!/\S/.test(node.nodeValue))continue;
      var p=node.parentElement;
      if(!p||!usable(p))continue;
      if(p.closest&&p.closest('#wwwpdf-panel'))continue;
      range.selectNodeContents(node);
      var rects=range.getClientRects();
      for(var j=0;j<rects.length;j++){var rr=rects[j];
        if(rr.height){pts.push(Math.round(rr.bottom+sy+1));count++;}}
    }
    pts=Array.from(new Set(pts)).sort(function(x,y){return x-y});
    return JSON.stringify({h:Math.ceil(h),w:Math.round(e.clientWidth),b:pts});
  }catch(err){return JSON.stringify({h:0,w:0,b:[]})}
})()"#;

/// Undo CAPTURE_PREP_JS (safe to run repeatedly): drop the capture style and
/// give the page its real scheduling APIs back.
const CAPTURE_DONE_JS: &str =
    "(function(){var s=document.getElementById('wwwpdf-capture');if(s)s.remove();if(window.wwwToPdf&&window.wwwToPdf.__captureThaw)window.wwwToPdf.__captureThaw();})()";

/// Settle probe, run repeatedly (with page JS still LIVE) before the freeze:
/// reports the current document height and how many images are still loading.
/// The render loop grows the frame to this height — which puts the whole
/// document "in the viewport", firing the IntersectionObservers lazy-loading
/// sites key off — and repeats until the height stops changing and images are
/// done, so nothing below the fold is missing from the capture.
#[cfg(any(target_os = "macos", target_os = "ios"))]
const SETTLE_JS: &str = r#"(function(){
  try{
    var d=document,b=d.body,e=d.documentElement;
    // Measure CONTENT height, not the viewport. documentElement.scrollHeight
    // is max(content, frameHeight); since the settle loop grows the frame past
    // the content to trigger below-fold lazy loading, reading it back would
    // just echo the frame height and never converge. body.scrollHeight tracks
    // the content itself. Fall back to documentElement only for the rare page
    // that scrolls on <html> with an empty <body>.
    var h=Math.max(b?b.scrollHeight:0,b?b.offsetHeight:0);
    if(h<1)h=Math.max(e.scrollHeight,e.offsetHeight);
    var pending=0,imgs=d.images;
    for(var i=0;i<imgs.length&&i<4000;i++){if(!imgs[i].complete)pending++;}
    return JSON.stringify({h:Math.ceil(h),p:pending});
  }catch(err){return '{"h":0,"p":0}'}
})()"#;

/// Settle measurements reported by SETTLE_JS.
#[cfg(any(target_os = "macos", target_os = "ios"))]
#[derive(serde::Deserialize)]
struct Settle {
    /// full document height, CSS px
    h: f64,
    /// images not yet finished loading
    p: u32,
}

/// Set the WKWebView frame size (width and/or height); returns the previous
/// size. wry attaches the webview with an autoresizing mask, not Auto Layout
/// constraints, so a direct setFrameSize sticks until the window resizes.
#[cfg(any(target_os = "macos", target_os = "ios"))]
async fn set_webview_frame(
    webview: &tauri::WebviewWindow,
    w: Option<f64>,
    h: Option<f64>,
) -> Result<(f64, f64), String> {
    use crate::geom::{CGRect, CGSize};
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    let (tx, rx) = tokio::sync::oneshot::channel::<Result<(f64, f64), String>>();
    let tx = std::sync::Mutex::new(Some(tx));
    webview
        .with_webview(move |platform| unsafe {
            let Some(tx) = tx.lock().unwrap().take() else { return };
            let wk = platform.inner() as *mut AnyObject;
            if wk.is_null() {
                let _ = tx.send(Err("webview handle was null".into()));
                return;
            }
            let fr: CGRect = msg_send![wk, frame];
            // setFrame: (CGRect) works on both NSView (macOS) and UIView (iOS);
            // setFrameSize: is NSView-only. Keep the origin, change the size.
            let new = CGRect {
                origin: fr.origin,
                size: CGSize {
                    width: w.unwrap_or(fr.size.width),
                    height: h.unwrap_or(fr.size.height),
                },
            };
            let _: () = msg_send![wk, setFrame: new];
            let _ = tx.send(Ok((fr.size.width, fr.size.height)));
        })
        .map_err(|e| e.to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(10), rx)
        .await
        .map_err(|_| "frame update timed out".to_string())?
        .map_err(|_| "frame update dropped".to_string())?
}

/// iOS: size the WKWebView to its superview and let UIKit keep it there.
/// wry attaches the webview with an autoresizing mask (not Auto Layout), so its
/// initial frame can be a fixed size smaller than the screen. Setting the frame
/// to the superview bounds plus a flexible width/height mask makes it fill and
/// follow rotation / multitasking resizes. Guarded so a not-yet-laid-out view
/// (zero bounds) is left alone rather than collapsed.
#[cfg(target_os = "ios")]
fn fit_webview_to_superview(webview: &tauri::WebviewWindow) {
    use crate::geom::CGRect;
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    let _ = webview.with_webview(|platform| unsafe {
        let wk = platform.inner() as *mut AnyObject;
        if wk.is_null() {
            return;
        }
        let sv: *mut AnyObject = msg_send![wk, superview];
        if sv.is_null() {
            return;
        }
        let b: CGRect = msg_send![sv, bounds];
        if b.size.width > 1.0 && b.size.height > 1.0 {
            let _: () = msg_send![wk, setFrame: b];
            // UIViewAutoresizingFlexibleWidth (2) | FlexibleHeight (16) = 18.
            let _: () = msg_send![wk, setAutoresizingMask: 18usize];
        }
    });
}

/// Evaluate JS in the target webview and return its string result. Runs via
/// the native evaluateJavaScript (works on any origin, bypasses page CSP).
#[cfg(any(target_os = "macos", target_os = "ios"))]
async fn eval_js_string(webview: &tauri::WebviewWindow, script: &str) -> Result<String, String> {
    use block2::RcBlock;
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use objc2::class;

    let (tx, rx) = tokio::sync::oneshot::channel::<Result<String, String>>();
    let tx = std::sync::Mutex::new(Some(tx));
    let script = script.to_string();
    webview
        .with_webview(move |platform| unsafe {
            let Some(tx) = tx.lock().unwrap().take() else { return };
            let wk = platform.inner() as *mut AnyObject;
            if wk.is_null() {
                let _ = tx.send(Err("webview handle was null".into()));
                return;
            }
            let c = std::ffi::CString::new(script.as_str()).unwrap_or_default();
            let ns: *mut AnyObject =
                msg_send![class!(NSString), stringWithUTF8String: c.as_ptr()];
            let txc = std::sync::Mutex::new(Some(tx));
            let block = RcBlock::new(move |result: *mut AnyObject, err: *mut AnyObject| {
                let Some(tx) = txc.lock().unwrap().take() else { return };
                if !result.is_null() {
                    let utf8: *const std::os::raw::c_char = msg_send![result, UTF8String];
                    let s = if utf8.is_null() {
                        String::new()
                    } else {
                        std::ffi::CStr::from_ptr(utf8).to_string_lossy().into_owned()
                    };
                    let _ = tx.send(Ok(s));
                } else if !err.is_null() {
                    let d: *mut AnyObject = msg_send![err, localizedDescription];
                    let utf8: *const std::os::raw::c_char = msg_send![d, UTF8String];
                    let s = if utf8.is_null() {
                        "JS evaluation failed".to_string()
                    } else {
                        std::ffi::CStr::from_ptr(utf8).to_string_lossy().into_owned()
                    };
                    let _ = tx.send(Err(s));
                } else {
                    let _ = tx.send(Err("JS returned no result".into()));
                }
            });
            let _: () = msg_send![wk, evaluateJavaScript: ns, completionHandler: &*block];
        })
        .map_err(|e| e.to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(30), rx)
        .await
        .map_err(|_| "JS evaluation timed out".to_string())?
        .map_err(|_| "JS completion dropped".to_string())?
}

/// Render webview content to PDF bytes via WKWebView.createPDF. With no rect
/// the whole view is captured (nil configuration — the frame is pre-sized to
/// the content height). With a rect, only that portion of the view renders
/// (WKPDFConfiguration.rect, top-left origin, view coordinates) — used to
/// capture tall documents in segments, because Core Graphics clamps a single
/// PDF page to 14,400 pt (~22 US-Letter pages) and silently cuts the rest.
#[cfg(any(target_os = "macos", target_os = "ios"))]
async fn wk_create_pdf(
    webview: &tauri::WebviewWindow,
    rect: Option<geom::CGRect>,
) -> Result<Vec<u8>, String> {
    use block2::RcBlock;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};

    let (tx, rx) = tokio::sync::oneshot::channel::<Result<Vec<u8>, String>>();
    let tx = std::sync::Mutex::new(Some(tx));
    webview
        .with_webview(move |platform| unsafe {
            let Some(tx) = tx.lock().unwrap().take() else { return };
            let wk = platform.inner() as *mut AnyObject;
            if wk.is_null() {
                let _ = tx.send(Err("webview handle was null".into()));
                return;
            }
            let config: *mut AnyObject = match rect {
                Some(r) => {
                    let c: *mut AnyObject = msg_send![class!(WKPDFConfiguration), new];
                    let _: () = msg_send![c, setRect: r];
                    c
                }
                None => std::ptr::null_mut(),
            };
            let txc = std::sync::Mutex::new(Some(tx));
            let block = RcBlock::new(move |data: *mut AnyObject, err: *mut AnyObject| {
                let Some(tx) = txc.lock().unwrap().take() else { return };
                if !data.is_null() {
                    let len: usize = msg_send![data, length];
                    let ptr: *const u8 = msg_send![data, bytes];
                    if ptr.is_null() || len == 0 {
                        let _ = tx.send(Err("createPDF returned empty data".into()));
                    } else {
                        let _ = tx.send(Ok(std::slice::from_raw_parts(ptr, len).to_vec()));
                    }
                } else if !err.is_null() {
                    let d: *mut AnyObject = msg_send![err, localizedDescription];
                    let utf8: *const std::os::raw::c_char = msg_send![d, UTF8String];
                    let s = if utf8.is_null() {
                        "createPDF failed".to_string()
                    } else {
                        std::ffi::CStr::from_ptr(utf8).to_string_lossy().into_owned()
                    };
                    let _ = tx.send(Err(s));
                } else {
                    let _ = tx.send(Err("createPDF returned neither data nor error".into()));
                }
            });
            let _: () = msg_send![
                wk,
                createPDFWithConfiguration: config,
                completionHandler: &*block
            ];
            if !config.is_null() {
                // createPDF has copied what it needs; balance the +1 from new.
                let _: () = msg_send![config, autorelease];
            }
        })
        .map_err(|e| e.to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(120), rx)
        .await
        .map_err(|_| "createPDF timed out".to_string())?
        .map_err(|_| "createPDF completion dropped".to_string())?
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
async fn render_pdf(
    webview: &tauri::WebviewWindow,
    p: &Margins,
    out_path: &str,
) -> Result<(), String> {
    use std::time::Duration;
    const PX_PER_IN: f64 = 96.0;

    // The width the live DOM must reflow to: printable inches at CSS 96dpi.
    let printable_w_px = ((8.5 - p.left - p.right).max(1.0)) * PX_PER_IN;
    let raw_path = std::env::temp_dir().join("wwwtopdf-raw.pdf");
    let raw_str = raw_path.to_string_lossy().into_owned();

    // 1. Reflow to print width (remember the original frame). Page JS stays
    //    LIVE through the settle phase below — lazy-loaded content needs its
    //    timers and observers to materialize; the editor's enforcement layer
    //    keeps removed/blocked ads hidden the whole time. The freeze comes
    //    later, inside CAPTURE_PREP_JS.
    let (old_w, old_h) = set_webview_frame(webview, Some(printable_w_px), None).await?;

    // Everything else runs inside a block so the frame/chrome ALWAYS restore.
    let captured: Result<(Meas, Vec<paginate::Segment>), String> = async {
        tokio::time::sleep(Duration::from_millis(150)).await;

        // 2. Settle: long articles lazy-render below the fold (infinite
        //    scroll, IntersectionObserver-driven hydration, lazy images), so
        //    a height measured too early truncates the PDF. Grow the frame to
        //    the current content height — which puts everything "in the
        //    viewport" and fires the observers — and repeat until the height
        //    stops moving and no images are mid-load. Bounded: ~4s worst case.
        let mut last_h = 0.0_f64;
        let mut stable = 0u32;
        for _ in 0..20 {
            let json = eval_js_string(webview, SETTLE_JS).await.unwrap_or_default();
            let s: Settle = serde_json::from_str(&json).unwrap_or(Settle { h: 0.0, p: 0 });
            if s.h < 1.0 {
                break;
            }
            if (s.h - last_h).abs() <= 2.0 && s.p == 0 {
                stable += 1;
                if stable >= 2 {
                    break;
                }
            } else {
                stable = 0;
            }
            if s.h > last_h {
                set_webview_frame(webview, None, Some(s.h + 8.0)).await?;
            }
            last_h = s.h;
            tokio::time::sleep(Duration::from_millis(250)).await;
        }

        // 3. Freeze the page (CAPTURE_PREP_JS calls __captureFreeze first, so
        //    nothing runs between here and the capture), hide chrome, and
        //    measure (getBoundingClientRect forces fresh layout).
        let json = eval_js_string(webview, CAPTURE_PREP_JS).await?;
        let meas: Meas =
            serde_json::from_str(&json).map_err(|e| format!("bad measurement: {e}"))?;
        if meas.h < 1.0 || meas.w < 1.0 {
            return Err("could not measure the page".into());
        }

        // 4. Grow the frame to the full content height so the whole document
        //    is laid out (usually a no-op after the settle phase), then
        //    capture. Core Graphics clamps a single PDF page to 14,400 pt
        //    (~19,200 px, ~22 US-Letter pages) and silently drops the rest —
        //    the "long article loses its last pages" bug — so a document past
        //    ~7,800 px is captured as several page-aligned SEGMENTS via
        //    WKPDFConfiguration.rect instead of one giant page. Segment cuts
        //    land exactly on output-page boundaries, so no text line can
        //    straddle a segment edge.
        set_webview_frame(webview, None, Some(meas.h + 8.0)).await?;
        tokio::time::sleep(Duration::from_millis(150)).await;
        let tops = paginate::compute_page_tops_px(&meas, p);
        const SEG_MAX_PX: f64 = 7800.0;
        let seg_bounds = paginate::plan_segments(&tops, meas.h, SEG_MAX_PX);
        let mut segments: Vec<paginate::Segment> = Vec::with_capacity(seg_bounds.len());
        if seg_bounds.len() == 1 {
            // Short document: the proven whole-view capture path.
            let pdf = wk_create_pdf(webview, None).await?;
            std::fs::write(&raw_path, &pdf).map_err(|e| format!("write raw pdf: {e}"))?;
            segments.push(paginate::Segment { path: raw_str.clone(), top: 0.0 });
        } else {
            for (i, &(seg_top, seg_end)) in seg_bounds.iter().enumerate() {
                let rect = geom::CGRect {
                    origin: geom::CGPoint { x: 0.0, y: seg_top },
                    size: geom::CGSize {
                        width: meas.w,
                        height: seg_end - seg_top,
                    },
                };
                let pdf = wk_create_pdf(webview, Some(rect)).await?;
                let seg_path = std::env::temp_dir().join(format!("wwwtopdf-raw-{i}.pdf"));
                std::fs::write(&seg_path, &pdf)
                    .map_err(|e| format!("write segment pdf: {e}"))?;
                segments.push(paginate::Segment {
                    path: seg_path.to_string_lossy().into_owned(),
                    top: seg_top,
                });
            }
        }
        Ok((meas, segments))
    }
    .await;

    // 5. Restore frame and chrome (and thaw the page) regardless of outcome.
    let _ = set_webview_frame(webview, Some(old_w), Some(old_h)).await;
    let _ = webview.eval(CAPTURE_DONE_JS);
    let (meas, segments) = captured?;

    // 6. Paginate to US Letter at the user's margins (pure Rust).
    let tops = paginate::compute_page_tops_px(&meas, p);
    paginate::paginate_segments(&segments, out_path, p, &meas, &tops)?;

    match std::fs::metadata(out_path) {
        Ok(m) if m.len() > 0 => Ok(()),
        _ => Err("pagination produced no output".into()),
    }
}

// Non-Apple desktop (Linux/Windows) and Android have no createPDF; PDF export
// there is unimplemented. The app still builds and runs.
#[cfg(not(any(target_os = "macos", target_os = "ios")))]
async fn render_pdf(
    _webview: &tauri::WebviewWindow,
    _p: &Margins,
    _out_path: &str,
) -> Result<(), String> {
    Err("PDF rendering is currently implemented for macOS only.".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // The one and only window/webview: starts on the bundled URL-entry
            // page, then navigates to target sites in place. The editor engine
            // is installed as an init script (runs on every page, remote or
            // local — it suppresses itself on our own page via __WWWPDF_IS_APP).
            let handle = app.handle().clone();
            let init = format!(
                "window.__WWWPDF_PRESETS = {};\n{}",
                presets_json_for_js(&load_presets(&handle)),
                EDITOR_JS
            );
            // Build the Bushido ad-block engine in the background — the
            // EasyList fetch/parse takes a beat and must not block the window.
            // Pages loaded before it's ready fall back to the editor's
            // built-in selector list until the next load or filter refresh.
            {
                let h = handle.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let dir = h.path().app_data_dir().ok();
                    match bushido::AdBlocker::init(dir.as_deref()) {
                        Ok(b) => *h.state::<AppState>().adblock.lock().unwrap() = Some(b),
                        Err(e) => eprintln!("www-to-pdf: ad-block engine unavailable: {e}"),
                    }
                });
            }
            let nav_handle = handle.clone();
            let load_handle = handle.clone();
            // `mut` is only used on desktop (inner_size below); mobile keeps it as-is.
            #[allow(unused_mut)]
            let mut builder =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("Prepare source")
                    .user_agent(WEBVIEW_UA)
                    .initialization_script(init)
                    .on_navigation(move |url| !handle_sentinel(&nav_handle, url))
                    .on_page_load(move |_wv, payload| {
                        if !matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                            return;
                        }
                        // Any finished load is a good moment to persist the
                        // session (a login just navigated somewhere).
                        save_cookies(&load_handle);
                        // The first page that finishes loading is our own
                        // URL-entry page; remember it as "home" so "New URL"
                        // can return here. is_home tells this page apart from a
                        // loaded target site.
                        let is_home = {
                            let state = load_handle.state::<AppState>();
                            let mut home = state.home.lock().unwrap();
                            if home.is_none() {
                                *home = Some(payload.url().clone());
                            }
                            home.as_ref() == Some(payload.url())
                        };
                        // Push current presets to each freshly-loaded page so a
                        // page opened after a preset change isn't stuck with the
                        // startup snapshot from the init script.
                        if let Some(w) = load_handle.get_webview_window("main") {
                            let json = presets_json_for_js(&load_presets(&load_handle));
                            let _ = w.eval(&format!(
                                "window.wwwToPdf&&window.wwwToPdf.presetsUpdated&&window.wwwToPdf.presetsUpdated({json})"
                            ));
                        }
                        if is_home {
                            // Back on the URL-entry page: fill the recent list
                            // with the titles captured from visited pages.
                            push_history_titles(&load_handle);
                        } else {
                            // A target site finished loading: record its title.
                            capture_history_title(&load_handle);
                            // Push the page's ad filters: once right away, and
                            // again after late ad scripts have added the
                            // classes/ids the first harvest couldn't see.
                            let h = load_handle.clone();
                            tauri::async_runtime::spawn(async move {
                                for delay_ms in [300u64, 2500] {
                                    tokio::time::sleep(std::time::Duration::from_millis(
                                        delay_ms,
                                    ))
                                    .await;
                                    push_adblock_selectors(&h).await;
                                }
                            });
                        }
                    });
            // Desktop gets an initial + minimum window size. On mobile the window
            // is the whole device screen; forcing an inner_size there leaves the
            // webview a fixed 1100x800 box pinned to the top-left instead of
            // filling the screen (the iPad "content in the corner" bug).
            #[cfg(desktop)]
            {
                builder = builder.inner_size(1100.0, 800.0).min_inner_size(380.0, 480.0);
            }
            let window = builder.build()?;

            // Bring back the previous run's logins before anything remote
            // loads, and take a final cookie snapshot when the window closes
            // (page-load snapshots are the primary persistence; this catches
            // a login made just before quitting).
            restore_cookies(&handle);
            let close_handle = handle.clone();
            window.on_window_event(move |event| {
                if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                    save_cookies(&close_handle);
                }
            });

            // iOS: make the webview actually fill its container and track
            // rotation / Stage-Manager resizes. wry's initial frame can be
            // smaller than the screen; pin it to the superview bounds with a
            // flexible autoresizing mask once the view hierarchy is laid out.
            #[cfg(target_os = "ios")]
            {
                let h = handle.clone();
                tauri::async_runtime::spawn(async move {
                    // Re-fit a few times: the view hierarchy may not be laid out
                    // on the first tick, and a launch-time rotation can change
                    // the bounds. Each call is idempotent (and no-ops on a
                    // not-yet-sized view).
                    for delay in [300u64, 900, 2000] {
                        tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                        if let Some(w) = h.get_webview_window("main") {
                            fit_webview_to_superview(&w);
                        }
                    }
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running www-to-pdf");
}
