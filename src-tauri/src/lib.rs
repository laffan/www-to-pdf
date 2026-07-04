// www-to-pdf — native app entry point (Tauri 2)
//
// The main window hosts the same web UI as the GitHub Pages build. The native
// advantage is that we can open ANY url in a real webview and inject the editor
// engine into it — something a browser iframe forbids for cross-origin sites.
// The engine is embedded at compile time and installed as an initialization
// script, so its toolbar appears automatically on every page the webview loads.

use tauri::{WebviewUrl, WebviewWindowBuilder};

// The shared editor engine, embedded so the native build is self-contained.
const EDITOR_JS: &str = include_str!("../../public/editor.js");

/// Open a target URL in its own webview window with the editor injected.
/// The user can log in, remove elements, tune fonts, then hit "Save as PDF"
/// (which calls window.print() → the OS print/PDF dialog).
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![open_target])
        .run(tauri::generate_context!())
        .expect("error while running www-to-pdf");
}
