// Bushido-style ad blocking (cosmetic filtering).
//
// Named for the approach of the Bushido browser
// (https://github.com/visualstudioblyat/bushido), which pairs Brave's
// `adblock-rust` engine with the EasyList filter set. We use the same
// MPL-2.0-licensed engine (no GPL code is copied from Bushido itself) scoped
// to what a PDF capture actually needs: element hiding. EasyList is fetched
// at runtime and cached in the app data dir — it is not redistributed with
// the app — and refreshed when the cache is older than a week.
//
// Flow: `AdBlocker::init` builds the engine once in the background at app
// start; when a target page finishes loading, lib.rs harvests the page's
// class names / ids, asks `selectors_for` for the matching hide-selectors
// (URL-specific EasyList rules + generic rules keyed to the harvested
// classes/ids, minus that site's exception rules), and evals them into the
// page, where the editor applies them as `display:none !important` CSS.

use std::path::Path;
use std::time::Duration;

use adblock::lists::{FilterSet, ParseOptions};
use adblock::Engine;

const EASYLIST_URL: &str = "https://easylist.to/easylist/easylist.txt";
const CACHE_FILE: &str = "easylist.txt";
const CACHE_MAX_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
/// A real EasyList is megabytes of text; anything tiny is a captive portal or
/// error page, not a filter list.
const MIN_LIST_BYTES: usize = 100 * 1024;

pub struct AdBlocker {
    engine: Engine,
}

impl AdBlocker {
    /// Build from the cached list if it's fresh, else download (writing the
    /// cache for next launch), else fall back to a stale cache — any cached
    /// copy beats no ad blocking when offline.
    pub fn init(cache_dir: Option<&Path>) -> Result<Self, String> {
        let cache = cache_dir.map(|d| d.join(CACHE_FILE));
        if let Some(text) = cache.as_deref().and_then(read_fresh) {
            return Ok(Self::from_filter_list(&text));
        }
        match download_list() {
            Ok(text) => {
                if let Some(p) = cache.as_deref() {
                    if let Some(dir) = p.parent() {
                        let _ = std::fs::create_dir_all(dir);
                    }
                    let _ = std::fs::write(p, &text);
                }
                Ok(Self::from_filter_list(&text))
            }
            Err(e) => match cache.as_deref().and_then(|p| std::fs::read_to_string(p).ok()) {
                Some(text) if text.len() >= MIN_LIST_BYTES => Ok(Self::from_filter_list(&text)),
                _ => Err(e),
            },
        }
    }

    pub fn from_filter_list(text: &str) -> Self {
        let mut set = FilterSet::new(false);
        set.add_filter_list(text.to_string(), ParseOptions::default());
        Self {
            engine: Engine::new_with_filter_set(set),
        }
    }

    /// CSS selectors to hide on `url`: the list's URL-specific rules plus
    /// generic rules keyed to the classes/ids actually present in the page
    /// (how uBlock/Bushido apply generic cosmetic filters), honouring the
    /// site's exception (`#@#`) and `generichide` rules.
    pub fn selectors_for(&self, url: &str, classes: &[String], ids: &[String]) -> Vec<String> {
        let res = self.engine.url_cosmetic_resources(url);
        let mut out: Vec<String> = res.hide_selectors.into_iter().collect();
        if !res.generichide {
            out.extend(
                self.engine
                    .hidden_class_id_selectors(classes, ids, &res.exceptions),
            );
        }
        out.sort();
        out.dedup();
        out
    }
}

fn read_fresh(p: &Path) -> Option<String> {
    let age = std::fs::metadata(p).ok()?.modified().ok()?.elapsed().ok()?;
    if age > CACHE_MAX_AGE {
        return None;
    }
    let text = std::fs::read_to_string(p).ok()?;
    (text.len() >= MIN_LIST_BYTES).then_some(text)
}

fn download_list() -> Result<String, String> {
    let mut resp = ureq::get(EASYLIST_URL)
        .config()
        .timeout_global(Some(Duration::from_secs(60)))
        .build()
        .call()
        .map_err(|e| format!("EasyList download failed: {e}"))?;
    let text = resp
        .body_mut()
        .with_config()
        .limit(20 * 1024 * 1024)
        .read_to_string()
        .map_err(|e| format!("EasyList read failed: {e}"))?;
    if text.len() < MIN_LIST_BYTES {
        return Err("EasyList download looked truncated".into());
    }
    Ok(text)
}
