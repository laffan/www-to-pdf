// www-to-pdf — native app entry point (Tauri 2)
//
// Four-stage flow:
//   1. main window   — URL entry + history (local UI).
//   2. target window — the remote page with a minimal injected toolbar
//                      (log in, remove elements). "Next" fires a sentinel
//                      navigation that we intercept below.
//   3. preview window— local UI (same index.html, label "preview"): fonts,
//                      metadata, margins, and a live preview that is the REAL
//                      generated PDF (rendered to a temp file, displayed via
//                      the asset protocol).
//   4. save          — native save dialog (desktop) / share sheet (iOS),
//                      copying the already-rendered preview so what you saw is
//                      exactly what you save.
//
// The preview window is local, so it can use normal Tauri IPC. Only the
// remote target webview needs the sentinel-navigation trick (app-command IPC
// from dynamically-created remote webviews is denied by Tauri's ACL).

use std::sync::Mutex;
use tauri::{Manager, Url, WebviewUrl, WebviewWindowBuilder};

// The shared editor engine, embedded so the native build is self-contained.
const EDITOR_JS: &str = include_str!("../../public/editor.js");

// The editor navigates here when stage 2 is done; see editor.js (STAGE3_HOST).
const STAGE3_HOST: &str = "wwwtopdf.stage3";
// Preset save/delete requests arrive the same way (editor.js PRESET_HOST).
const PRESET_HOST: &str = "wwwtopdf.preset";

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
    if let Some(w) = app.get_webview_window("target") {
        let json = presets_json_for_js(&presets);
        let msg_js = serde_json::to_string(&msg).unwrap_or_else(|_| "\"\"".into());
        let _ = w.eval(&format!(
            "window.wwwToPdf&&(window.wwwToPdf.presetsUpdated&&window.wwwToPdf.presetsUpdated({json}),window.wwwToPdf.toast&&window.wwwToPdf.toast({msg_js}))"
        ));
    }
}

#[derive(Clone, Default, serde::Serialize)]
struct PageInfo {
    title: String,
    url: String,
}

#[derive(Default)]
struct AppState {
    page: Mutex<PageInfo>,
}

struct Margins {
    // inches
    top: f64,
    right: f64,
    bottom: f64,
    left: f64,
}

/// Where the live preview PDF lives. Must stay inside the asset-protocol scope
/// declared in tauri.conf.json ($TEMP/**).
fn preview_path() -> std::path::PathBuf {
    std::env::temp_dir().join("wwwtopdf-preview.pdf")
}

/// Stage 1 → 2: open the URL in its own webview with the editor injected.
#[tauri::command]
fn open_target(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let parsed: Url = url.parse().map_err(|e| format!("Invalid URL: {e}"))?;
    let app_for_nav = app.clone();

    // Saved presets ride along with the editor so the toolbar can list them
    // immediately (the remote page has no IPC to ask with).
    let init_script = format!(
        "window.__WWWPDF_PRESETS = {};\n{}",
        presets_json_for_js(&load_presets(&app)),
        EDITOR_JS
    );

    WebviewWindowBuilder::new(&app, "target", WebviewUrl::External(parsed))
        .title("www → pdf — page")
        .initialization_script(init_script)
        .inner_size(1024.0, 768.0)
        .on_navigation(move |nav_url| {
            if nav_url.host_str() == Some(STAGE3_HOST) {
                stash_page_info(&app_for_nav, nav_url);
                let app = app_for_nav.clone();
                tauri::async_runtime::spawn(async move {
                    open_preview(&app);
                });
                return false; // cancel — the edited page stays put
            }
            if nav_url.host_str() == Some(PRESET_HOST) {
                let app = app_for_nav.clone();
                let url = nav_url.clone();
                tauri::async_runtime::spawn(async move {
                    handle_preset_nav(&app, &url);
                });
                return false;
            }
            true
        })
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}

fn stash_page_info(app: &tauri::AppHandle, nav_url: &Url) {
    let get = |key: &str| -> String {
        nav_url
            .query_pairs()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.into_owned())
            .unwrap_or_default()
    };
    let info = PageInfo {
        title: get("title"),
        url: get("url"),
    };
    // Backfill the URL-entry history with the real page title (the main window
    // only had the URL when the user clicked Load).
    if !info.title.is_empty() && !info.url.is_empty() {
        if let Some(main) = app.get_webview_window("main") {
            let u = serde_json::to_string(&info.url).unwrap_or_else(|_| "\"\"".into());
            let t = serde_json::to_string(&info.title).unwrap_or_else(|_| "\"\"".into());
            let _ = main.eval(&format!(
                "window.__wwwpdfSetHistoryTitle&&window.__wwwpdfSetHistoryTitle({u},{t})"
            ));
        }
    }
    *app.state::<AppState>().page.lock().unwrap() = info;
}

/// Stage 2 → 3: open (or refresh) the PDF-settings window.
fn open_preview(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("preview") {
        // Re-entry from stage 2: reload so the UI re-reads page info and
        // renders a fresh preview of the current DOM.
        let _ = w.eval("location.reload()");
        let _ = w.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "preview", WebviewUrl::App("index.html".into()))
        .title("www → pdf — output")
        .inner_size(1150.0, 820.0)
        .min_inner_size(760.0, 500.0)
        .build();
}

/// Title/URL captured at the stage-2→3 hand-off, for prefilling metadata.
#[tauri::command]
fn get_page_info(state: tauri::State<'_, AppState>) -> PageInfo {
    state.page.lock().unwrap().clone()
}

/// Stage 3: push font/metadata settings into the target page's DOM (they must
/// live there to appear in the rendered PDF). eval works on any origin.
#[tauri::command]
fn apply_settings(app: tauri::AppHandle, settings: serde_json::Value) -> Result<(), String> {
    let webview = app
        .get_webview_window("target")
        .ok_or_else(|| "The page window was closed — go back to the URL entry.".to_string())?;
    let js = format!("window.wwwToPdf&&window.wwwToPdf.applySettings({settings})");
    webview.eval(&js).map_err(|e| e.to_string())
}

/// Stage 3: render the current state of the target page to the preview PDF,
/// then stamp header/footer/page numbers into the margins.
/// Returns the file path; the UI displays it via the asset protocol.
///
/// MARGIN CONTRACT: WebKit computes the print *layout* width from the @page
/// CSS injected in the target page, while NSPrintInfo margins control where
/// each rendered tile is *placed* on the paper. The two must carry the same
/// values or text reflows to the wrong width and gets cropped — so the UI
/// sends margins both to apply_settings (CSS) and here (native).
#[tauri::command]
async fn render_preview(
    app: tauri::AppHandle,
    mt: f64,
    mr: f64,
    mb: f64,
    ml: f64,
    header: Option<String>,
    footer: Option<String>,
    page_numbers: Option<bool>,
) -> Result<String, String> {
    let webview = app
        .get_webview_window("target")
        .ok_or_else(|| "The page window was closed — go back to the URL entry.".to_string())?;
    let clamp = |v: f64| v.clamp(0.0, 3.0);
    let m = Margins {
        top: clamp(mt),
        right: clamp(mr),
        bottom: clamp(mb),
        left: clamp(ml),
    };
    let out = preview_path();
    let out_str = out.to_string_lossy().into_owned();
    render_pdf(&webview, &m, &out_str).await?;

    fn non_empty(o: &Option<String>) -> Option<&str> {
        o.as_deref().map(str::trim).filter(|s| !s.is_empty())
    }
    stamp_header_footer(
        &out_str,
        &m,
        non_empty(&header),
        non_empty(&footer),
        page_numbers.unwrap_or(false),
    )?;
    Ok(out_str)
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

/// Stage 4: ask where to save (desktop) or share (iOS). The preview file IS
/// the current PDF, so saving is a copy — guaranteed to match what was shown.
/// Returns Some(path) on save, None if the user cancelled.
#[cfg(not(target_os = "ios"))]
#[tauri::command]
async fn save_pdf(app: tauri::AppHandle, suggested: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let src = preview_path();
    if !src.exists() {
        return Err("No rendered PDF yet — adjust a setting to generate one.".into());
    }

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("PDF", &["pdf"])
        .set_file_name(format!("{}.pdf", sanitize(&suggested)))
        .save_file(move |picked| {
            let _ = tx.send(picked);
        });

    let picked = rx.await.map_err(|_| "save dialog closed unexpectedly".to_string())?;
    match picked {
        Some(file_path) => {
            let dest = file_path.into_path().map_err(|e| e.to_string())?;
            std::fs::copy(&src, &dest).map_err(|e| format!("Could not write PDF: {e}"))?;
            Ok(Some(dest.to_string_lossy().into_owned()))
        }
        None => Ok(None),
    }
}

/// iOS: hand the PDF to the share sheet (UIActivityViewController).
#[cfg(target_os = "ios")]
#[tauri::command]
async fn save_pdf(app: tauri::AppHandle, _suggested: String) -> Result<Option<String>, String> {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};

    let src = preview_path();
    if !src.exists() {
        return Err("No rendered PDF yet — adjust a setting to generate one.".into());
    }
    let webview = app
        .get_webview_window("target")
        .ok_or_else(|| "The page window was closed.".to_string())?;
    let path = src.to_string_lossy().into_owned();

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
            // iPad requires a popover anchor.
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

    Ok(Some("(share sheet)".into()))
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
//   2. injected JS hides the tool chrome and measures content height plus the
//      bottom edge of every block element (safe page-break candidates);
//   3. WKWebView.createPDF renders ONE tall page at exactly that width;
//   4. paginate_tall_pdf (pure Rust, unit-tested) slices it into US-Letter
//      pages at the user's margins, snapping breaks to paragraph gaps so no
//      text line is ever split;
//   5. the webview frame and chrome are restored.
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

/// Measurements reported by the injected capture-prep script.
#[derive(serde::Deserialize)]
struct Meas {
    /// full document height, CSS px
    h: f64,
    /// actual layout width, CSS px (sanity signal: should equal the target)
    w: f64,
    /// bottom edges of block elements, CSS px from document top — safe breaks
    b: Vec<f64>,
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
    var st=document.getElementById('wwwpdf-capture');
    if(!st){st=document.createElement('style');st.id='wwwpdf-capture';
      st.textContent='#wwwpdf-panel,#wwwpdf-toast{display:none!important}html::after{display:none!important}';
      document.documentElement.appendChild(st);}
    var d=document,b=d.body,e=d.documentElement;
    var h=Math.max(b?b.scrollHeight:0,e.scrollHeight,b?b.offsetHeight:0,e.offsetHeight);
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

/// Undo CAPTURE_PREP_JS (safe to run repeatedly).
const CAPTURE_DONE_JS: &str =
    "(function(){var s=document.getElementById('wwwpdf-capture');if(s)s.remove();})()";

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

/// Render the webview's full content to PDF bytes via WKWebView.createPDF
/// (nil configuration = the whole view; the frame is pre-sized to the full
/// content height so the whole document is captured).
#[cfg(any(target_os = "macos", target_os = "ios"))]
async fn wk_create_pdf(webview: &tauri::WebviewWindow) -> Result<Vec<u8>, String> {
    use block2::RcBlock;
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

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
                createPDFWithConfiguration: std::ptr::null_mut::<AnyObject>(),
                completionHandler: &*block
            ];
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

    // 1. Reflow to print width (remember the original frame).
    let (old_w, old_h) = set_webview_frame(webview, Some(printable_w_px), None).await?;

    // Everything else runs inside a block so the frame/chrome ALWAYS restore.
    let captured: Result<Meas, String> = async {
        tokio::time::sleep(Duration::from_millis(150)).await;

        // 2. Hide chrome + measure (getBoundingClientRect forces fresh layout).
        let json = eval_js_string(webview, CAPTURE_PREP_JS).await?;
        let meas: Meas =
            serde_json::from_str(&json).map_err(|e| format!("bad measurement: {e}"))?;
        if meas.h < 1.0 || meas.w < 1.0 {
            return Err("could not measure the page".into());
        }

        // 3. Grow the frame to the full content height so createPDF captures
        //    the entire document, then render.
        set_webview_frame(webview, None, Some(meas.h + 8.0)).await?;
        tokio::time::sleep(Duration::from_millis(150)).await;
        let pdf = wk_create_pdf(webview).await?;
        std::fs::write(&raw_path, &pdf).map_err(|e| format!("write raw pdf: {e}"))?;
        Ok(meas)
    }
    .await;

    // 4. Restore frame and chrome regardless of outcome.
    let _ = set_webview_frame(webview, Some(old_w), Some(old_h)).await;
    let _ = webview.eval(CAPTURE_DONE_JS);
    let meas = captured?;

    // 5. Paginate to US Letter at the user's margins (pure Rust).
    paginate_tall_pdf(&raw_str, out_path, p, &meas)?;

    match std::fs::metadata(out_path) {
        Ok(m) if m.len() > 0 => Ok(()),
        _ => Err("pagination produced no output".into()),
    }
}

/// Slice one tall PDF page into US-Letter pages with the given margins.
/// Pure Rust (lopdf) and platform-independent; unit-tested by probe.
///
/// Geometry: the source page (width Wsrc) is drawn on each output page as a
/// Form XObject scaled by s = content_width / Wsrc, offset so that slice k's
/// top lands at the top of the content box, clipped to the content box. Slice
/// boundaries snap to the nearest measured block-bottom (paragraph gap) at or
/// above the ideal cut so text lines are never split across pages.
fn paginate_tall_pdf(
    src: &str,
    dst: &str,
    m: &Margins,
    meas: &Meas,
) -> Result<(), String> {
    use lopdf::{dictionary, Document, Object, Stream};

    let mut doc = Document::load(src).map_err(|e| format!("paginate: load: {e}"))?;
    let pages = doc.get_pages();
    let &src_id = pages.values().next().ok_or("paginate: source has no pages")?;

    // Source page geometry.
    let src_dict = doc
        .get_dictionary(src_id)
        .map_err(|e| e.to_string())?
        .clone();
    let (w_src, h_src) = match src_dict.get(b"MediaBox").and_then(|o| o.as_array()) {
        Ok(mb) if mb.len() == 4 => {
            let f = |o: &Object| o.as_float().unwrap_or(0.0) as f64;
            (f(&mb[2]) - f(&mb[0]), f(&mb[3]) - f(&mb[1]))
        }
        _ => return Err("paginate: source page has no MediaBox".into()),
    };
    if w_src < 1.0 || h_src < 1.0 {
        return Err("paginate: degenerate source page".into());
    }

    // Wrap the source page's content + resources in a Form XObject.
    let content = doc
        .get_page_content(src_id)
        .map_err(|e| format!("paginate: content: {e}"))?;
    let resources_obj = src_dict
        .get(b"Resources")
        .cloned()
        .unwrap_or(Object::Dictionary(lopdf::Dictionary::new()));
    let parent_id = src_dict
        .get(b"Parent")
        .and_then(|o| o.as_reference())
        .map_err(|_| "paginate: source page has no Parent".to_string())?;
    let form_id = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "BBox" => vec![0.into(), 0.into(), w_src.into(), h_src.into()],
            "Resources" => resources_obj,
        },
        content,
    ));

    // Output geometry (US Letter, points).
    let (pw, ph) = (612.0_f64, 792.0_f64);
    let (lm, rm) = (m.left * 72.0, m.right * 72.0);
    let (tm, bm) = (m.top * 72.0, m.bottom * 72.0);
    let cw = (pw - lm - rm).max(36.0);
    let ch = (ph - tm - bm).max(36.0);
    let s = cw / w_src;
    // CSS px -> source pt (guards against any DPR scaling in the capture).
    let ratio = w_src / meas.w.max(1.0);
    let content_h = (meas.h * ratio).min(h_src).max(1.0);
    let slice_h = ch / s; // source units per output page

    // Page tops (source pt, from document top), snapped to safe breaks.
    let breaks: Vec<f64> = meas.b.iter().map(|y| y * ratio).collect();
    let mut tops = vec![0.0_f64];
    let mut t = 0.0_f64;
    while t + slice_h < content_h - 1.0 && tops.len() < 500 {
        let ideal = t + slice_h;
        // Largest break at/above the cut, but keep at least 40% of a page.
        let snapped = breaks
            .iter()
            .copied()
            .filter(|y| *y <= ideal - 2.0 && *y > t + slice_h * 0.4)
            .fold(f64::NAN, f64::max);
        let next = if snapped.is_nan() { ideal } else { snapped };
        tops.push(next);
        t = next;
    }
    let n = tops.len();

    // Build the output pages.
    let mut kids: Vec<Object> = Vec::with_capacity(n);
    for (k, &t_k) in tops.iter().enumerate() {
        // This page's band ends at the NEXT page's (snapped) top — and the
        // clip must end there too, or the strip between the snapped break and
        // the full content box shows on BOTH pages (a clipped line at the
        // bottom of page k duplicated in full at the top of page k+1).
        let band_end = tops
            .get(k + 1)
            .copied()
            .unwrap_or_else(|| content_h.min(t_k + slice_h));
        let clip_h = (s * (band_end - t_k)).clamp(1.0, ch);
        let clip_y0 = (ph - tm) - clip_h;
        // Map source band-top to the top of the content box.
        let ty = (ph - tm) - s * (h_src - t_k);
        let ops = format!(
            "q {lm:.2} {clip_y0:.2} {cw:.2} {clip_h:.2} re W n {s:.6} 0 0 {s:.6} {lm:.2} {ty:.2} cm /Fm0 Do Q"
        );
        let cs = doc.add_object(Stream::new(dictionary! {}, ops.into_bytes()));
        let page = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => Object::Reference(parent_id),
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
            "Resources" => dictionary! {
                "XObject" => dictionary! { "Fm0" => Object::Reference(form_id) },
            },
            "Contents" => Object::Reference(cs),
        });
        kids.push(Object::Reference(page));
    }

    // Swap the page tree over to the new pages.
    let pages_dict = doc
        .get_dictionary_mut(parent_id)
        .map_err(|e| e.to_string())?;
    pages_dict.set("Kids", Object::Array(kids));
    pages_dict.set("Count", Object::Integer(n as i64));
    pages_dict.set(
        "MediaBox",
        vec![0.into(), 0.into(), 612.into(), 792.into()],
    );

    doc.save(dst).map_err(|e| format!("paginate: save: {e}"))?;
    Ok(())
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
        .invoke_handler(tauri::generate_handler![
            open_target,
            get_page_info,
            apply_settings,
            render_preview,
            save_pdf
        ])
        .run(tauri::generate_context!())
        .expect("error while running www-to-pdf");
}
