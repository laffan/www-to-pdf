// www-to-pdf — native app entry point (Tauri 2)
//
// The main window hosts the same web UI as the GitHub Pages build. The native
// advantage is that we can open ANY url in a real webview and inject the editor
// engine into it — something a browser iframe forbids for cross-origin sites.
// The engine is embedded at compile time and installed as an initialization
// script, so its toolbar appears automatically on every page the webview loads.
//
// Because `window.print()` is unsupported/unreliable in WKWebView (macOS/iOS),
// "Save as PDF" is served by the native `export_pdf` command below, which renders
// the webview to a real vector PDF via WKWebView's `createPDF`.

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

// The shared editor engine, embedded so the native build is self-contained.
const EDITOR_JS: &str = include_str!("../../public/editor.js");

/// Open a target URL in its own webview window with the editor injected.
/// The user can log in, remove elements, tune fonts, then hit "Save as PDF".
#[tauri::command]
fn open_target(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let parsed: tauri::Url = url.parse().map_err(|e| format!("Invalid URL: {e}"))?;

    WebviewWindowBuilder::new(&app, "target", WebviewUrl::External(parsed))
        .title("www → pdf — target")
        .initialization_script(EDITOR_JS)
        .inner_size(1024.0, 768.0)
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Render the calling webview to a PDF and save it to the user's Downloads
/// (desktop) or the app's Documents dir (iOS). Returns the saved path.
///
/// `webview` is injected by Tauri as the webview that made the call — i.e. the
/// target page the user has been editing.
#[tauri::command]
async fn export_pdf(
    webview: tauri::WebviewWindow,
    app: tauri::AppHandle,
    title: Option<String>,
) -> Result<String, String> {
    let bytes = render_pdf(&webview).await?;

    let dir = app
        .path()
        .download_dir()
        .or_else(|_| app.path().document_dir())
        .map_err(|e| format!("No place to save: {e}"))?;
    std::fs::create_dir_all(&dir).ok();

    let base = sanitize(title.as_deref().unwrap_or("page"));
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let path = dir.join(format!("{base}-{stamp}.pdf"));

    std::fs::write(&path, bytes).map_err(|e| format!("Could not write PDF: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Keep only filesystem-friendly characters for the generated filename.
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

// ---- WKWebView.createPDF (macOS / iOS) -----------------------------------
#[cfg(any(target_os = "macos", target_os = "ios"))]
async fn render_pdf(webview: &tauri::WebviewWindow) -> Result<Vec<u8>, String> {
    use block2::RcBlock;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use std::sync::Mutex;

    let (tx, rx) = tokio::sync::oneshot::channel::<Result<Vec<u8>, String>>();
    // The completion block is `Fn` (may be stored/called by WebKit), so the
    // one-shot sender lives behind a Mutex<Option<…>> and is taken on first use.
    let tx = Mutex::new(Some(tx));

    webview
        .with_webview(move |platform| {
            // SAFETY: `inner()` is the live WKWebView pointer for this webview;
            // we only message it and copy bytes out of the returned NSData.
            unsafe {
                let wk = platform.inner() as *mut AnyObject;
                if wk.is_null() {
                    if let Some(t) = tx.lock().unwrap().take() {
                        let _ = t.send(Err("webview handle was null".into()));
                    }
                    return;
                }

                // Default WKPDFConfiguration.rect is null => capture the whole page.
                let config: *mut AnyObject = msg_send![class!(WKPDFConfiguration), new];

                let handler = RcBlock::new(move |data: *mut AnyObject, err: *mut AnyObject| {
                    let result = if !data.is_null() {
                        let len: usize = msg_send![data, length];
                        let ptr: *const u8 = msg_send![data, bytes];
                        if ptr.is_null() || len == 0 {
                            Err("createPDF returned empty data".to_string())
                        } else {
                            Ok(std::slice::from_raw_parts(ptr, len).to_vec())
                        }
                    } else if !err.is_null() {
                        let desc: *mut AnyObject = msg_send![err, localizedDescription];
                        Err(ns_string_to_rust(desc).unwrap_or_else(|| "createPDF failed".into()))
                    } else {
                        Err("createPDF returned neither data nor error".to_string())
                    };
                    if let Some(t) = tx.lock().unwrap().take() {
                        let _ = t.send(result);
                    }
                });

                let _: () =
                    msg_send![wk, createPDFWithConfiguration: config, completionHandler: &*handler];
            }
        })
        .map_err(|e| e.to_string())?;

    rx.await
        .map_err(|_| "PDF completion handler was dropped".to_string())?
}

/// Copy an NSString into a Rust String (UTF-8).
#[cfg(any(target_os = "macos", target_os = "ios"))]
unsafe fn ns_string_to_rust(ns: *mut objc2::runtime::AnyObject) -> Option<String> {
    use objc2::msg_send;
    if ns.is_null() {
        return None;
    }
    let bytes: *const std::os::raw::c_char = msg_send![ns, UTF8String];
    if bytes.is_null() {
        return None;
    }
    std::ffi::CStr::from_ptr(bytes)
        .to_str()
        .ok()
        .map(|s| s.to_owned())
}

// Non-Apple platforms don't have createPDF; the tool's PDF export targets
// macOS/iOS. This keeps the crate compiling for desktop-Linux/Windows dev.
#[cfg(not(any(target_os = "macos", target_os = "ios")))]
async fn render_pdf(_webview: &tauri::WebviewWindow) -> Result<Vec<u8>, String> {
    Err("Native PDF export is only implemented for macOS and iOS.".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![open_target, export_pdf])
        .run(tauri::generate_context!())
        .expect("error while running www-to-pdf");
}
