// www-to-pdf — native app entry point (Tauri 2)
//
// The main window hosts the same web UI as the GitHub Pages build. The native
// advantage: we open ANY url in a real webview and inject the editor engine into
// it — something a browser iframe forbids for cross-origin sites. The engine is
// embedded at compile time and installed as an initialization script, so its
// toolbar appears automatically on every page the webview loads.
//
// Export: window.print() is unreliable in WKWebView, and app-command IPC from a
// dynamically-created remote webview is denied by Tauri's ACL. So "Save as PDF"
// signals the app by navigating to a sentinel URL, which the `on_navigation`
// handler below intercepts (cancelling the navigation) and turns into a native
// render via AppKit's print pipeline — real US-Letter pages with the user's
// margins.

use tauri::{Manager, Url, WebviewUrl, WebviewWindowBuilder};

// The shared editor engine, embedded so the native build is self-contained.
const EDITOR_JS: &str = include_str!("../../public/editor.js");

// The editor navigates here to request a PDF; see public/editor.js (EXPORT_HOST).
const EXPORT_HOST: &str = "wwwtopdf.export";

struct ExportParams {
    title: String,
    // margins in inches
    top: f64,
    right: f64,
    bottom: f64,
    left: f64,
}

/// Open a target URL in its own webview window with the editor injected, and an
/// `on_navigation` hook that turns the editor's sentinel navigation into a
/// native PDF export.
#[tauri::command]
fn open_target(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let parsed: Url = url.parse().map_err(|e| format!("Invalid URL: {e}"))?;
    let app_for_nav = app.clone();

    WebviewWindowBuilder::new(&app, "target", WebviewUrl::External(parsed))
        .title("www → pdf — target")
        .initialization_script(EDITOR_JS)
        .inner_size(1024.0, 768.0)
        .on_navigation(move |nav_url| {
            if nav_url.host_str() == Some(EXPORT_HOST) {
                let params = parse_params(nav_url);
                let app = app_for_nav.clone();
                tauri::async_runtime::spawn(async move {
                    let result = do_export(&app, params).await;
                    report(&app, result);
                });
                return false; // cancel — the page the user edited stays put
            }
            true
        })
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}

fn parse_params(url: &Url) -> ExportParams {
    let get = |key: &str| -> Option<String> {
        url.query_pairs()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.into_owned())
    };
    let margin = |key: &str| -> f64 {
        get(key)
            .and_then(|s| s.parse::<f64>().ok())
            .filter(|v| *v >= 0.0 && *v <= 3.0)
            .unwrap_or(1.0)
    };
    ExportParams {
        title: get("title").unwrap_or_default(),
        top: margin("mt"),
        right: margin("mr"),
        bottom: margin("mb"),
        left: margin("ml"),
    }
}

async fn do_export(app: &tauri::AppHandle, p: ExportParams) -> Result<String, String> {
    let webview = app
        .get_webview_window("target")
        .ok_or_else(|| "target window not found".to_string())?;

    let dir = app
        .path()
        .download_dir()
        .or_else(|_| app.path().document_dir())
        .map_err(|e| format!("No place to save: {e}"))?;
    std::fs::create_dir_all(&dir).ok();

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let path = dir.join(format!("{}-{}.pdf", sanitize(&p.title), stamp));
    let path_str = path.to_string_lossy().into_owned();

    render_pdf(&webview, &p, &path_str).await?;
    Ok(path_str)
}

/// Push the outcome back into the editor's toast (via script injection, which —
/// unlike IPC — works on any origin).
fn report(app: &tauri::AppHandle, result: Result<String, String>) {
    if let Some(webview) = app.get_webview_window("target") {
        let (ok, msg) = match result {
            Ok(path) => (true, path),
            Err(e) => (false, e),
        };
        let msg_json = serde_json::to_string(&msg).unwrap_or_else(|_| "\"\"".into());
        let js = format!("window.wwwToPdf&&window.wwwToPdf.afterExport({ok},{msg_json})");
        let _ = webview.eval(&js);
    }
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
#[cfg(target_os = "macos")]
async fn render_pdf(
    webview: &tauri::WebviewWindow,
    p: &ExportParams,
    out_path: &str,
) -> Result<(), String> {
    use objc2::encode::{Encode, Encoding};
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};

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
    let out_path = out_path.to_string();

    let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    let tx = std::sync::Mutex::new(Some(tx));

    webview
        .with_webview(move |platform| {
            // SAFETY: `inner()` is this webview's live WKWebView; we build a save
            // print operation and run it on the main thread.
            unsafe {
                let wk = platform.inner() as *mut AnyObject;
                let send = |r: Result<(), String>| {
                    if let Some(t) = tx.lock().unwrap().take() {
                        let _ = t.send(r);
                    }
                };
                if wk.is_null() {
                    return send(Err("webview handle was null".into()));
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

                // Job disposition -> save; destination URL in the info dictionary.
                let _: () = msg_send![info, setJobDisposition: nsstring("NSPrintSaveJob")];
                let dict: *mut AnyObject = msg_send![info, dictionary];
                let file_url: *mut AnyObject =
                    msg_send![class!(NSURL), fileURLWithPath: nsstring(&out_path)];
                let key = nsstring("NSPrintJobSavingURL");
                let _: () = msg_send![dict, setObject: file_url, forKey: key];

                let op: *mut AnyObject = msg_send![wk, printOperationWithPrintInfo: info];
                if op.is_null() {
                    return send(Err("could not create print operation".into()));
                }
                let _: () = msg_send![op, setShowsPrintPanel: false];
                let _: () = msg_send![op, setShowsProgressPanel: false];
                let ok: bool = msg_send![op, runOperation];
                send(if ok {
                    Ok(())
                } else {
                    Err("print operation failed".into())
                });
            }
        })
        .map_err(|e| e.to_string())?;

    rx.await
        .map_err(|_| "print completion was dropped".to_string())?
}

// iOS export (UIPrintPageRenderer -> PDF) is not implemented yet; the app runs,
// but PDF export currently targets macOS.
#[cfg(not(target_os = "macos"))]
async fn render_pdf(
    _webview: &tauri::WebviewWindow,
    _p: &ExportParams,
    _out_path: &str,
) -> Result<(), String> {
    Err("PDF export is currently implemented for macOS only.".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![open_target])
        .run(tauri::generate_context!())
        .expect("error while running www-to-pdf");
}
