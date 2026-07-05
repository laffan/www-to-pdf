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

    WebviewWindowBuilder::new(&app, "target", WebviewUrl::External(parsed))
        .title("www → pdf — page")
        .initialization_script(EDITOR_JS)
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
    let state = app.state::<AppState>();
    *state.page.lock().unwrap() = PageInfo {
        title: get("title"),
        url: get("url"),
    };
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

    let non_empty = |o: &Option<String>| o.as_deref().map(str::trim).filter(|s| !s.is_empty());
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

// ---- macOS: AppKit print-to-PDF (US Letter, margins, paginated) -----------
//
// Two hard-won correctness rules encoded here:
//
// 1. WKWebView paginates print content in a SEPARATE process, serviced by the
//    main runloop. The synchronous `runOperation` blocks that runloop, so
//    pagination never converges and the spool file grows without bound
//    (observed: a 550 MB unopenable PDF and a crash). The operation MUST be
//    run asynchronously via runOperationModalForWindow:…didRunSelector:, with
//    completion delivered to a delegate.
//
// 2. AppKit string constants are NOT their symbol names at runtime (e.g.
//    NSPrintJobSavingURL is "NSJobSavingURL"). Hand-writing the literals
//    silently misses, and AppKit throws up a save dialog because the save job
//    has no destination. We link the real symbols so the linker guarantees
//    the values.

#[cfg(target_os = "macos")]
#[link(name = "AppKit", kind = "framework")]
extern "C" {
    // NSString* constants (the symbol is a global holding the object pointer).
    static NSPrintSaveJob: *mut objc2::runtime::AnyObject;
    static NSPrintJobSavingURL: *mut objc2::runtime::AnyObject;
}

/// Completion callback for NSPrintOperation's async run. `contextInfo` carries
/// a boxed oneshot sender for the result.
#[cfg(target_os = "macos")]
unsafe extern "C" fn print_did_run(
    _this: *mut objc2::runtime::AnyObject,
    _cmd: objc2::runtime::Sel,
    _op: *mut objc2::runtime::AnyObject,
    success: objc2::runtime::Bool,
    context: *mut std::ffi::c_void,
) {
    if context.is_null() {
        return;
    }
    let tx = Box::from_raw(
        context as *mut tokio::sync::oneshot::Sender<Result<(), String>>,
    );
    let _ = tx.send(if success.as_bool() {
        Ok(())
    } else {
        Err("print operation failed or was cancelled".into())
    });
}

/// Lazily register a one-off Objective-C delegate class + shared instance for
/// print completions. The instance is stateless (context carries the payload),
/// so a single leaked object serves every export.
#[cfg(target_os = "macos")]
fn print_delegate() -> *mut objc2::runtime::AnyObject {
    use objc2::runtime::{AnyObject, Bool, ClassBuilder, Sel};
    use objc2::{class, msg_send, sel};
    use std::sync::OnceLock;

    static INSTANCE: OnceLock<usize> = OnceLock::new();
    *INSTANCE.get_or_init(|| {
        let mut builder = ClassBuilder::new(c"WwwToPdfPrintDelegate", class!(NSObject))
            .expect("delegate class name already taken");
        unsafe {
            builder.add_method(
                sel!(printOperationDidRun:success:contextInfo:),
                print_did_run
                    as unsafe extern "C" fn(
                        *mut AnyObject,
                        Sel,
                        *mut AnyObject,
                        Bool,
                        *mut std::ffi::c_void,
                    ),
            );
        }
        let cls = builder.register();
        let obj: *mut AnyObject = unsafe { msg_send![cls, new] };
        obj as usize
    }) as *mut objc2::runtime::AnyObject
}

#[cfg(target_os = "macos")]
async fn render_pdf(
    webview: &tauri::WebviewWindow,
    p: &Margins,
    out_path: &str,
) -> Result<(), String> {
    use objc2::encode::{Encode, Encoding};
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send, sel};

    // Minimal CGSize so we can pass NSPrintInfo.paperSize by value without the
    // objc2-foundation feature-flag chain.
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGSize {
        width: f64,
        height: f64,
    }
    unsafe impl Encode for CGSize {
        const ENCODING: Encoding =
            Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
    }

    const PT_PER_IN: f64 = 72.0;
    // US Letter, in points.
    let paper = CGSize { width: 8.5 * PT_PER_IN, height: 11.0 * PT_PER_IN };
    let (top, right, bottom, left) = (
        p.top * PT_PER_IN,
        p.right * PT_PER_IN,
        p.bottom * PT_PER_IN,
        p.left * PT_PER_IN,
    );
    let out_path_owned = out_path.to_string();

    let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    let tx = std::sync::Mutex::new(Some(tx));

    webview
        .with_webview(move |platform| {
            // Runs on the main thread. SAFETY: `inner()`/`ns_window()` are this
            // webview's live WKWebView/NSWindow; the print operation retains
            // what it needs, and completion arrives via the delegate above.
            unsafe {
                let tx = tx.lock().unwrap().take();
                let Some(tx) = tx else { return };
                let wk = platform.inner() as *mut AnyObject;
                let win = platform.ns_window() as *mut AnyObject;
                if wk.is_null() || win.is_null() {
                    let _ = tx.send(Err("webview/window handle was null".into()));
                    return;
                }

                let nsstring = |s: &str| -> *mut AnyObject {
                    let c = std::ffi::CString::new(s).unwrap_or_default();
                    msg_send![class!(NSString), stringWithUTF8String: c.as_ptr()]
                };

                // NSPrintInfo configured for a silent save-to-PDF job.
                let info: *mut AnyObject = msg_send![class!(NSPrintInfo), new];
                let _: () = msg_send![info, setPaperSize: paper];
                let _: () = msg_send![info, setTopMargin: top];
                let _: () = msg_send![info, setBottomMargin: bottom];
                let _: () = msg_send![info, setLeftMargin: left];
                let _: () = msg_send![info, setRightMargin: right];
                let _: () = msg_send![info, setHorizontallyCentered: false];
                let _: () = msg_send![info, setVerticallyCentered: false];
                // NSPrintingPaginationMode: 0=Automatic, 1=Fit, 2=Clip. Fit scales
                // wide content down to the printable width.
                let _: () = msg_send![info, setHorizontalPagination: 1usize];
                let _: () = msg_send![info, setVerticalPagination: 0usize];

                // Save-to-file disposition + destination, via the REAL AppKit
                // symbols (see note above about literal values).
                let _: () = msg_send![info, setJobDisposition: NSPrintSaveJob];
                let dict: *mut AnyObject = msg_send![info, dictionary];
                let file_url: *mut AnyObject =
                    msg_send![class!(NSURL), fileURLWithPath: nsstring(&out_path_owned)];
                let _: () = msg_send![dict, setObject: file_url, forKey: NSPrintJobSavingURL];

                let op: *mut AnyObject = msg_send![wk, printOperationWithPrintInfo: info];
                if op.is_null() {
                    let _ = tx.send(Err("could not create print operation".into()));
                    return;
                }
                let _: () = msg_send![op, setShowsPrintPanel: false];
                let _: () = msg_send![op, setShowsProgressPanel: false];

                // Async run; the delegate's callback fires when WebKit has
                // finished paginating and the file is written.
                let context = Box::into_raw(Box::new(tx)) as *mut std::ffi::c_void;
                let _: () = msg_send![
                    op,
                    runOperationModalForWindow: win,
                    delegate: print_delegate(),
                    didRunSelector: sel!(printOperationDidRun:success:contextInfo:),
                    contextInfo: context
                ];
            }
        })
        .map_err(|e| e.to_string())?;

    // Guard against a completion that never arrives (e.g. WebKit wedges).
    let result = tokio::time::timeout(std::time::Duration::from_secs(180), rx)
        .await
        .map_err(|_| "PDF render timed out after 180s".to_string())?
        .map_err(|_| "print completion was dropped".to_string())?;
    result?;

    // The delegate reported success — sanity-check the artifact.
    match std::fs::metadata(out_path) {
        Ok(m) if m.len() > 0 => Ok(()),
        Ok(_) => Err("print finished but the PDF is empty".into()),
        Err(_) => Err("print finished but no file was written".into()),
    }
}

// iOS export (UIPrintPageRenderer -> PDF) is not implemented yet; the app runs,
// but PDF export currently targets macOS.
#[cfg(not(target_os = "macos"))]
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
