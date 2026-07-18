/*
 * www-to-pdf — editor engine
 * -------------------------------------------------------------------------
 * A self-contained editing toolbar that runs INSIDE a target page's own
 * context. Because it lives in the page (not a parent frame) it can freely
 * read and mutate the DOM, which is exactly what the same-origin policy
 * forbids a cross-origin parent from doing.
 *
 * It is delivered three ways, all loading this identical file:
 *   1. Bookmarklet    — user clicks it while on the target site.
 *   2. Iframe inject  — web app injects it into a same-origin / framable page.
 *   3. Tauri webview  — injected as an initialization script.
 *
 * Public surface: window.wwwToPdf.mount(options) and .unmount().
 * The script auto-mounts on load unless window.__WWWTOPDF_NO_AUTOMOUNT is set.
 */
(function () {
  "use strict";

  var NS = "wwwpdf";
  if (window.wwwToPdf && window.wwwToPdf.__mounted) {
    // Already present: bring the panel back into view instead of duplicating.
    window.wwwToPdf.mount();
    return;
  }

  // ---- state ---------------------------------------------------------------
  var state = {
    removeMode: false,
    removed: [],        // stack of {el, prev} for undo
    bodyPx: null,       // null = untouched
    lineHeight: null,   // null = untouched
    headingScale: 1,
    // US Letter output; margins in inches.
    margins: { top: 1, right: 1, bottom: 1, left: 1 },
    marginGuide: false,
    // True while the native Format pane is showing the inline PDF preview
    // overlay (the real rendered PDF, drawn by pdf.js).
    previewMode: false,
    // Header/footer are stamped onto the rendered PDF by the native side.
    header: "",
    footer: "",
    pageNumbers: false,
    meta: {
      title: document.title || "",
      url: location.href,
      author: "",
      accessDate: new Date().toISOString().slice(0, 10),
      notes: "",
      show: false,
    },
    panelPos: { right: 16, top: 16 },
    // Bushido-style cosmetic ad blocking. `selectors` comes from the native
    // adblock engine (EasyList via adblock-rust) when available, else from the
    // built-in fallback list; hiding is a CSS rule so it also kills matching
    // nodes injected later. `userChoice` remembers an explicit toggle so an
    // engine update can't re-enable what the user turned off.
    adblock: { enabled: false, userChoice: null, source: "", selectors: [], cssText: "" },
  };

  // ---- small helpers -------------------------------------------------------
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === "style") n.style.cssText = attrs[k];
        else if (k === "class") n.className = attrs[k];
        else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2), attrs[k]);
        else n.setAttribute(k, attrs[k]);
      });
    }
    (kids || []).forEach(function (c) {
      n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return n;
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // ---- injected style (own + print rules) ----------------------------------
  function ensureStyle() {
    var s = document.getElementById(NS + "-style");
    if (s) return s;
    s = el("style", { id: NS + "-style" });
    document.documentElement.appendChild(s);
    render_style();
    return s;
  }
  function render_style() {
    var s = document.getElementById(NS + "-style");
    if (!s) return;
    var bodyDecl = "";
    if (state.bodyPx) bodyDecl += "font-size:" + state.bodyPx + "px !important;";
    if (state.lineHeight) bodyDecl += "line-height:" + state.lineHeight + " !important;";
    var bodyRule = bodyDecl
      ? "body, p, li, td, th, blockquote, dd, dt {" + bodyDecl + "}"
      : "";
    var hs = state.headingScale;
    var headRule =
      "h1{font-size:calc(2.0em*" + hs + ")!important}" +
      "h2{font-size:calc(1.6em*" + hs + ")!important}" +
      "h3{font-size:calc(1.3em*" + hs + ")!important}" +
      "h4{font-size:calc(1.1em*" + hs + ")!important}" +
      "h5{font-size:calc(1.0em*" + hs + ")!important}" +
      "h6{font-size:calc(0.9em*" + hs + ")!important}";
    var m = state.margins;
    // @page carries the margins for BOTH paths. Web: the browser print dialog
    // honours it directly. Native: WebKit derives the print LAYOUT width from
    // these margins while NSPrintInfo places the tiles — the preview window
    // keeps the two in sync by sending the same values to applySettings (here)
    // and to the native renderer. If they drift apart, text reflows to the
    // wrong width and gets cropped.
    var pageRule =
      "@page{size:8.5in 11in;margin:" +
      m.top + "in " + m.right + "in " + m.bottom + "in " + m.left + "in;}";
    // On-screen guide: an inset outline showing the printable area.
    var guideRule = state.marginGuide
      ? "html{position:relative}html::after{content:'';position:fixed;pointer-events:none;z-index:2147483646;" +
        "top:" + m.top + "in;right:" + m.right + "in;bottom:" + m.bottom + "in;left:" + m.left + "in;" +
        "outline:1px dashed #2563eb;outline-offset:0}"
      : "";
    s.textContent = [
      pageRule,
      "." + NS + "-removed{display:none!important}",
      state.adblock.enabled ? state.adblock.cssText : "",
      "." + NS + "-hi{outline:2px solid #e11d48!important;outline-offset:-2px!important;cursor:crosshair!important;background:rgba(225,29,72,.08)!important}",
      bodyRule,
      hs !== 1 ? headRule : "",
      guideRule,
      // The tool's own chrome must never appear in the exported PDF.
      "@media print{",
      "  #" + NS + "-panel,#" + NS + "-panel *,#" + NS + "-toast{display:none!important}",
      "  ." + NS + "-removed{display:none!important}",
      "  html::after{display:none!important}",
      "  #" + NS + "-meta{display:" + (state.meta.show ? "block" : "none") + "!important}",
      "}",
      // Phone form factor (portrait). The floating card would cover the whole
      // screen — dock the toolbar as a full-width bottom sheet so the preview
      // stays visible above it, and give the preview room to scroll clear of
      // the sheet. !important beats the panel's inline positioning; safe-area
      // insets keep the primary action above the home indicator / notch.
      "@media (max-width:480px){",
      "  #" + NS + "-panel{position:fixed!important;left:0!important;right:0!important;" +
        "top:auto!important;bottom:0!important;width:auto!important;max-width:none!important;" +
        "max-height:56vh!important;border-radius:16px 16px 0 0!important;" +
        "border-left:0!important;border-right:0!important;border-bottom:0!important;" +
        "padding-bottom:calc(12px + env(safe-area-inset-bottom,0px))!important;" +
        "box-shadow:0 -10px 34px rgba(0,0,0,.24)!important}",
      "  #" + NS + "-preview{padding-top:calc(20px + env(safe-area-inset-top,0px))!important;" +
        "padding-bottom:60vh!important}",
      "  #" + NS + "-toast{bottom:calc(60vh + env(safe-area-inset-bottom,0px))!important}",
      "}",
      // Metadata header. Everything is !important so host-site CSS (resets,
      // `body > div` rules, etc.) can't hide or restyle it — the cause of the
      // "shows in export but not on screen" bug. No horizontal padding: the
      // block must sit flush inside the page margins like the rest of the
      // content. Sans-serif by design.
      "#" + NS + "-meta{display:" + (state.meta.show ? "block" : "none") + "!important;" +
        "position:relative!important;z-index:2147483645!important;" +
        "font-family:system-ui,-apple-system,'Helvetica Neue',Arial,sans-serif!important;" +
        "border-bottom:1.5px solid #111!important;padding:0 0 12px!important;" +
        "margin:0 0 20px!important;background:transparent!important;color:#111!important;" +
        "max-width:none!important;width:auto!important;text-align:left!important}",
      "#" + NS + "-meta h1{font-size:19px!important;line-height:1.3!important;margin:0 0 8px!important;" +
        "font-family:inherit!important;color:inherit!important;font-weight:700!important}",
      "#" + NS + "-meta dl{display:grid!important;grid-template-columns:auto 1fr;gap:2px 14px;" +
        "margin:0!important;font-size:12px!important;font-family:inherit!important}",
      "#" + NS + "-meta dt{font-weight:600!important;color:#555!important;margin:0!important}",
      "#" + NS + "-meta dd{margin:0!important;color:inherit!important}",
    ].join("\n");
  }

  // ---- metadata header -----------------------------------------------------
  function renderMeta() {
    var host = document.getElementById(NS + "-meta");
    if (!host) {
      host = el("div", { id: NS + "-meta" });
      document.body.insertBefore(host, document.body.firstChild);
    }
    var m = state.meta;
    var rows = [
      ["URL", m.url],
      ["Author", m.author],
      ["Accessed", m.accessDate],
      ["Notes", m.notes],
    ]
      .filter(function (r) {
        return r[1];
      })
      .map(function (r) {
        return "<dt>" + esc(r[0]) + "</dt><dd>" + esc(r[1]) + "</dd>";
      })
      .join("");
    host.innerHTML =
      (m.title ? "<h1>" + esc(m.title) + "</h1>" : "") + "<dl>" + rows + "</dl>";
    render_style();
  }

  // ---- remove mode ---------------------------------------------------------
  var hovered = null;
  function onOver(e) {
    if (!state.removeMode) return;
    if (panelContains(e.target)) return;
    if (hovered) hovered.classList.remove(NS + "-hi");
    hovered = e.target;
    hovered.classList.add(NS + "-hi");
  }
  function onOut() {
    if (hovered) hovered.classList.remove(NS + "-hi");
    hovered = null;
  }
  function onClick(e) {
    if (!state.removeMode) return;
    if (panelContains(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    var t = e.target;
    t.classList.remove(NS + "-hi");
    // Record a durable selector alongside the node so the removal set can be
    // saved as a preset and replayed on a fresh load of a similar page, and
    // the node's prior inline display so Undo can restore it exactly.
    state.removed.push({ el: t, sel: cssPath(t), prev: hideNode(t) });
    updateCounts();
  }
  function panelContains(node) {
    var p = document.getElementById(NS + "-panel");
    return p && (node === p || p.contains(node));
  }
  function setRemoveMode(on) {
    state.removeMode = on;
    // The button may not be in the document yet (initial showPane runs while
    // the panel is still being built); default text/aria already match `off`.
    var btn = document.getElementById(NS + "-removebtn");
    if (btn) {
      btn.setAttribute("aria-pressed", on);
      btn.textContent = on ? "● Click elements to remove" : "Remove elements";
    }
    if (!on) onOut();
  }
  function undo() {
    var r = state.removed.pop();
    if (r) unhideNode(r.el, r.prev);
    updateCounts();
  }
  function resetRemoved() {
    state.removed.forEach(function (r) {
      unhideNode(r.el, r.prev);
    });
    state.removed = [];
    updateCounts();
  }

  // ---- removal enforcement ---------------------------------------------------
  // Hiding is just a class + CSS rule, so the page's own JS can resurrect a
  // "removed" element: ad scripts and framework re-renders replace nodes
  // wholesale (fresh element, no class) or rewrite `className`, wiping ours.
  // Both happen constantly on ad-heavy sites — especially during the native
  // renderer's pre-capture reflow, which ad slots treat as a window resize and
  // refresh into. This layer makes removals stick: a MutationObserver
  // re-asserts every recorded removal the moment the page mutates, adopting
  // replacement nodes via the recorded selector. Observer callbacks are
  // microtasks, which run before the next paint — a resurrected ad can never
  // reach the rendered frame that the PDF capture snapshots.
  var tracked = typeof WeakSet !== "undefined" ? new WeakSet() : null;
  function track(node) {
    if (tracked && node) tracked.add(node);
  }
  function untrack(node) {
    if (tracked && node) tracked.delete(node);
  }
  var enforcer = null;

  // Hide = class (for our CSS + bookkeeping) PLUS an inline
  // display:none!important. The inline declaration is what wins the CSS war:
  // anti-adblock rules like `#ad{display:block!important}` outrank a class
  // rule on specificity, but nothing in a stylesheet outranks an important
  // inline declaration.
  function reassert(n) {
    n.classList.add(NS + "-removed");
    try {
      n.style.setProperty("display", "none", "important");
    } catch (e) {}
    track(n);
  }
  function isHidden(n) {
    return (
      n.classList.contains(NS + "-removed") &&
      n.style.getPropertyValue("display") === "none" &&
      n.style.getPropertyPriority("display") === "important"
    );
  }
  // Returns the node's prior inline display ({v, p}) so Undo can restore it.
  function hideNode(n) {
    var prev = null;
    try {
      prev = {
        v: n.style.getPropertyValue("display"),
        p: n.style.getPropertyPriority("display"),
      };
    } catch (e) {}
    reassert(n);
    return prev;
  }
  function unhideNode(n, prev) {
    // Untrack BEFORE unhiding so the enforcement observer reads the change
    // as intentional and doesn't re-remove the element.
    untrack(n);
    n.classList.remove(NS + "-removed");
    try {
      if (prev && prev.v) n.style.setProperty("display", prev.v, prev.p);
      else n.style.removeProperty("display");
    } catch (e) {}
  }

  function enforceRemovals() {
    // All hiding lives in our <style>; re-create it first if the page tore it out.
    if (!document.getElementById(NS + "-style")) ensureStyle();
    var vanished = [];
    var changed = false;
    state.removed.forEach(function (r) {
      if (r.el && r.el.isConnected) {
        if (!isHidden(r.el)) {
          // The page wiped the class or the inline style (className rewrite,
          // style-attribute overwrite, re-render in place).
          reassert(r.el);
          changed = true;
        }
      } else if (r.sel) {
        vanished.push(r);
      }
    });
    // A removed node left the DOM. Either the capture detached it (detained:
    // it returns on thaw — just police NEW matches of its selector), or the
    // page replaced it: re-remove whatever the selector matches now — the
    // first match takes the old entry's place (so Undo / Reset keep working);
    // extra matches become new entries, exactly as if a preset removed them.
    vanished.forEach(function (r) {
      var detained = _detachedSet && _detachedSet.has(r.el);
      var nodes;
      try {
        nodes = document.querySelectorAll(r.sel);
      } catch (e) {
        return;
      }
      var adopted = false;
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (panelContains(n)) continue;
        if (n === document.body || n === document.documentElement) continue;
        if (n.hasAttribute && n.hasAttribute("data-" + NS + "-hole")) continue;
        if (isHidden(n)) continue;
        var prev = hideNode(n);
        if (!detained && !adopted) {
          r.el = n;
          r.prev = prev;
          adopted = true;
        } else {
          state.removed.push({ el: n, sel: r.sel, prev: prev });
        }
        changed = true;
      }
    });
    if (changed) updateCounts();
    return changed;
  }

  // ---- capture detach --------------------------------------------------------
  // For the capture itself, winning the CSS war still isn't the last word — so
  // hidden elements are physically DETACHED from the DOM while the renderer
  // (or the web print dialog) takes its snapshot: a node that isn't in the
  // document cannot be resurrected by any style trick. Each node is swapped
  // for an inert placeholder of the SAME tag (display:none, no attributes),
  // so sibling-structure styling of the kept content (:nth-child,
  // :nth-of-type, adjacent-sibling rules) doesn't shift — display:none
  // elements still count as siblings, and so do the placeholders. Thaw swaps
  // the originals back, which is what keeps Undo meaningful after a render.
  var _detached = null; // [{ph, el}] while a capture/print is in flight
  var _detachedSet = null;
  function detachForCapture() {
    if (_detached) return;
    enforceRemovals();
    _detached = [];
    _detachedSet = typeof WeakSet !== "undefined" ? new WeakSet() : null;
    var targets = [];
    var seen = typeof Set !== "undefined" ? new Set() : null;
    function target(n) {
      if (seen) {
        if (seen.has(n)) return;
        seen.add(n);
      }
      targets.push(n);
    }
    state.removed.forEach(function (r) {
      if (r.el && r.el.isConnected) target(r.el);
    });
    if (state.adblock.enabled) {
      state.adblock.selectors.forEach(function (sel) {
        var nodes;
        try {
          nodes = document.querySelectorAll(sel);
        } catch (e) {
          return;
        }
        for (var i = 0; i < nodes.length; i++) {
          var n = nodes[i];
          if (panelContains(n)) continue;
          if (n === document.body || n === document.documentElement) continue;
          target(n);
        }
      });
    }
    targets.forEach(function (n) {
      // A node inside an already-detached subtree leaves (and returns) with it.
      if (!n.parentNode || !n.isConnected) return;
      var ph;
      try {
        ph = document.createElement(n.tagName);
      } catch (e) {
        ph = document.createElement("div");
      }
      ph.setAttribute("data-" + NS + "-hole", "");
      try {
        ph.style.setProperty("display", "none", "important");
      } catch (e) {}
      try {
        n.parentNode.replaceChild(ph, n);
        _detached.push({ ph: ph, el: n });
        if (_detachedSet) _detachedSet.add(n);
      } catch (e) {}
    });
  }
  function reattachAfterCapture() {
    if (!_detached) return;
    _detached.forEach(function (d) {
      try {
        if (d.ph.parentNode) d.ph.parentNode.replaceChild(d.el, d.ph);
        else d.ph.remove();
      } catch (e) {}
    });
    _detached = null;
    _detachedSet = null;
  }

  function ensureEnforcer() {
    if (enforcer || typeof MutationObserver === "undefined") return;
    enforcer = new MutationObserver(function (muts) {
      if (!state.removed.length && !state.adblock.enabled) return;
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type === "childList") {
          if (m.addedNodes.length || m.removedNodes.length) {
            enforceRemovals();
            return;
          }
        } else if (m.type === "attributes") {
          // Busy pages rewrite class/style constantly; only a TRACKED node
          // losing its hiding (class wiped, or inline display overridden) is
          // worth a sweep.
          var t = m.target;
          if (t && t.nodeType === 1 && tracked && tracked.has(t) && !isHidden(t)) {
            enforceRemovals();
            return;
          }
        }
      }
    });
    enforcer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style"],
    });
  }
  function stopEnforcer() {
    if (enforcer) {
      enforcer.disconnect();
      enforcer = null;
    }
  }

  // ---- capture freeze --------------------------------------------------------
  // No page JS may run between removing elements and producing the PDF. The
  // native renderer calls __captureFreeze() before it reflows/captures and
  // __captureThaw() when the capture is over. Freezing (1) re-asserts every
  // removal and physically detaches the hidden elements (capture detach,
  // above), (2) cancels all pending timeouts / intervals / animation frames,
  // and (3) stubs the scheduling APIs so nothing new can be queued — ad
  // scripts observe the pre-capture resize, but their refresh callbacks never
  // fire. Anything that still slips through (a fetch handler already in
  // flight, code holding pre-freeze references to setTimeout) is caught by
  // the enforcement observer above. Thaw re-attaches the detached elements
  // and restores the real APIs; page timers pending before the freeze stay
  // cancelled — for a capture surface, that's the point.
  var _frozen = null;
  function captureFreeze() {
    // Re-assert removals, then take the hidden elements out of the DOM
    // entirely for the duration of the capture.
    detachForCapture();
    if (_frozen) return;
    var w = window;
    _frozen = {
      st: w.setTimeout,
      si: w.setInterval,
      raf: w.requestAnimationFrame,
      ric: w.requestIdleCallback,
    };
    try {
      // Timeout and interval ids share one id space, counting up from 1, and
      // clearTimeout/clearInterval are interchangeable per the HTML spec.
      var last = _frozen.st.call(w, function () {}, 0);
      for (var i = 1; i <= last && i < 2000000; i++) {
        w.clearTimeout(i);
        w.clearInterval(i);
      }
    } catch (e) {}
    try {
      if (_frozen.raf) {
        var lastRaf = _frozen.raf.call(w, function () {});
        for (var j = 1; j <= lastRaf && j < 2000000; j++) w.cancelAnimationFrame(j);
      }
    } catch (e) {}
    var fake = 1000000000; // far above any real id, so clears stay harmless
    w.setTimeout = function () { return ++fake; };
    w.setInterval = function () { return ++fake; };
    if (_frozen.raf) w.requestAnimationFrame = function () { return ++fake; };
    if (_frozen.ric) w.requestIdleCallback = function () { return ++fake; };
  }
  function captureThaw() {
    reattachAfterCapture();
    if (!_frozen) return;
    var w = window;
    w.setTimeout = _frozen.st;
    w.setInterval = _frozen.si;
    if (_frozen.raf) w.requestAnimationFrame = _frozen.raf;
    if (_frozen.ric) w.requestIdleCallback = _frozen.ric;
    _frozen = null;
  }

  // ---- durable selectors + presets -------------------------------------------
  // Class names with digits are usually build-hashed (css-1x2y3z) and won't
  // survive a redeploy, so only letter-ish classes anchor selectors.
  function stableClasses(node) {
    var out = [];
    var cls = node.classList || [];
    for (var i = 0; i < cls.length && out.length < 3; i++) {
      var c = cls[i];
      if (c.indexOf(NS) === 0) continue;
      if (!/^[A-Za-z][A-Za-z_-]{2,29}$/.test(c)) continue;
      out.push(c);
    }
    return out;
  }
  // Short, human-legible path: nearest sane id, else tag.classes segments with
  // nth-of-type only when a segment has no stable classes.
  function cssPath(node) {
    try {
      var SAFE_ID = /^[A-Za-z][\w-]{0,63}$/;
      if (node.id && SAFE_ID.test(node.id)) return "#" + node.id;
      var parts = [];
      var cur = node;
      var depth = 0;
      while (cur && cur.nodeType === 1 && cur.tagName !== "BODY" && cur.tagName !== "HTML" && depth < 5) {
        if (cur.id && SAFE_ID.test(cur.id)) {
          parts.unshift("#" + cur.id);
          break;
        }
        var seg = cur.localName;
        var sc = stableClasses(cur);
        if (sc.length) {
          seg += "." + sc.join(".");
        } else if (cur.parentElement) {
          var idx = 1;
          var sib = cur;
          while ((sib = sib.previousElementSibling)) {
            if (sib.localName === cur.localName) idx++;
          }
          seg += ":nth-of-type(" + idx + ")";
        }
        parts.unshift(seg);
        cur = cur.parentElement;
        depth++;
      }
      return parts.length ? parts.join(" > ") : null;
    } catch (e) {
      return null;
    }
  }

  // Apply a saved preset: remove everything its selectors match, feeding the
  // normal removed-stack so Undo/Reset keep working.
  function applyPreset(preset) {
    var applied = 0;
    (preset.selectors || []).forEach(function (sel) {
      var nodes;
      try {
        nodes = document.querySelectorAll(sel);
      } catch (e) {
        return; // selector no longer valid on this page — skip
      }
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (panelContains(n)) continue;
        if (n === document.body || n === document.documentElement) continue;
        if (n.classList.contains(NS + "-removed")) continue;
        state.removed.push({ el: n, sel: sel, prev: hideNode(n) });
        applied++;
      }
    });
    updateCounts();
    toast(
      applied
        ? "Removed " + applied + " element" + (applied > 1 ? "s" : "")
        : "No matching elements on this page"
    );
  }
  function updateCounts() {
    var c = document.getElementById(NS + "-count");
    if (c) c.textContent = state.removed.length + " removed";
  }

  // ---- Bushido ad blocking ---------------------------------------------------
  // Cosmetic ad filtering in the spirit of the Bushido browser: hide anything
  // matching known ad selectors. The native app computes the set with Brave's
  // adblock-rust engine over EasyList for the loaded URL and pushes it in via
  // wwwToPdf.setAdblockSelectors (replacing this fallback); where no engine is
  // available — the web build, or a native first run while offline — a small
  // built-in list of unambiguous ad selectors applies instead. Hiding is a CSS
  // rule, so nodes injected AFTER it's applied are dead on arrival too.
  var BUILTIN_AD_SELECTORS = [
    ".adsbygoogle",
    "[id^='div-gpt-ad']",
    "[id^='google_ads_iframe']",
    "iframe[id^='google_ads_frame']",
    "iframe[src*='doubleclick.net']",
    "iframe[src*='googlesyndication.com']",
    "iframe[src*='adsystem.']",
    "[data-ad-slot]",
    "[data-google-query-id]",
    "[data-testid='StandardAd']",
    "[aria-label='Advertisement' i]",
    ".ad-slot",
    ".ad-banner",
    ".ad-container",
    ".ad-wrapper",
    ".ad-unit",
    ".advertisement",
    "#sponsored-recirc",
    ".GoogleActiveViewElement",
  ];

  // Group into rules of 50 so one selector the engine can't parse (rejected
  // individually below, but belt-and-braces) can't invalidate everything.
  function buildAdblockCss(sels) {
    var rules = [];
    for (var i = 0; i < sels.length; i += 50) {
      rules.push(sels.slice(i, i + 50).join(",") + "{display:none!important}");
    }
    return rules.join("\n");
  }
  function setAdblockSelectors(list, source) {
    var valid = [];
    var seen = {};
    (Array.isArray(list) ? list : []).forEach(function (sel) {
      if (typeof sel !== "string") return;
      sel = sel.trim();
      if (!sel || seen[sel]) return;
      seen[sel] = 1;
      try {
        document.querySelector(sel); // this engine can't parse it -> skip
      } catch (e) {
        return;
      }
      valid.push(sel);
    });
    state.adblock.selectors = valid;
    state.adblock.source = source || "engine";
    state.adblock.cssText = buildAdblockCss(valid);
    if (state.adblock.userChoice !== false) {
      state.adblock.enabled = valid.length > 0;
    }
    render_style();
    refreshAdblockUI();
  }
  function adblockMatchedCount() {
    if (!state.adblock.enabled || typeof Set === "undefined") return 0;
    var found = new Set();
    state.adblock.selectors.forEach(function (sel) {
      var nodes;
      try {
        nodes = document.querySelectorAll(sel);
      } catch (e) {
        return;
      }
      for (var i = 0; i < nodes.length; i++) {
        if (!panelContains(nodes[i])) found.add(nodes[i]);
      }
    });
    return found.size;
  }
  // Rebound to the real updater when the panel is built.
  var refreshAdblockUI = function () {};
  function buildAdblock(isNative) {
    var cb = el("input", {
      type: "checkbox",
      onchange: function (e) {
        state.adblock.userChoice = e.target.checked;
        state.adblock.enabled = e.target.checked && state.adblock.selectors.length > 0;
        render_style();
        refreshAdblockUI();
      },
    });
    var label = el(
      "label",
      { style: "display:flex;align-items:center;gap:8px;cursor:pointer;padding:2px 0" },
      [cb, el("span", { style: "font-weight:600" }, ["Block ads"])]
    );
    var status = el("span", {
      id: NS + "-adcount",
      style: "font-size:11px;color:#71717a",
    });
    var rowKids = [status];
    if (isNative) {
      // Ask Rust to recompute the filter set (late-loading ads add classes/ids
      // the first harvest missed). Same sentinel channel as everything else.
      rowKids.push(
        el(
          "a",
          {
            href: "#",
            title: "Recompute ad filters for this page",
            style: "font:11px system-ui;color:#2563eb;text-decoration:none;cursor:pointer",
            onclick: function (e) {
              e.preventDefault();
              window.location.href = "https://" + ADBLOCK_HOST + "/?action=refresh";
            },
          },
          ["↻ Refresh filters"]
        )
      );
    }
    var row = el(
      "div",
      {
        style:
          "display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:2px",
      },
      rowKids
    );
    refreshAdblockUI = function () {
      cb.checked = state.adblock.enabled;
      if (!state.adblock.selectors.length) {
        status.textContent = "No ad filters loaded yet";
      } else {
        var src =
          state.adblock.source === "engine"
            ? state.adblock.selectors.length + " EasyList filters"
            : "built-in filters";
        status.textContent = state.adblock.enabled
          ? adblockMatchedCount() + " hidden · " + src
          : "off · " + src;
      }
    };
    refreshAdblockUI();
    return el("div", {}, [label, row]);
  }

  // ---- panel UI ------------------------------------------------------------
  var STYLE_BTN =
    "appearance:none;border:1px solid #d4d4d8;background:#fff;color:#18181b;" +
    "border-radius:8px;padding:8px 10px;font:500 13px system-ui,sans-serif;" +
    "cursor:pointer;width:100%;text-align:left";
  var STYLE_PRIMARY =
    "appearance:none;border:0;background:#111;color:#fff;border-radius:8px;" +
    "padding:11px 12px;font:600 14px system-ui,sans-serif;cursor:pointer;width:100%";

  function buildPanel() {
    var isNative = !!window.__TAURI_INTERNALS__;
    var panel = el("div", {
      id: NS + "-panel",
      style:
        "position:fixed;top:" +
        state.panelPos.top +
        "px;right:" +
        state.panelPos.right +
        "px;z-index:2147483647;width:264px;max-height:calc(100vh - 32px);" +
        "overflow:auto;background:#fafafa;border:1px solid #e4e4e7;border-radius:14px;" +
        "box-shadow:0 12px 40px rgba(0,0,0,.22);font:13px system-ui,-apple-system,sans-serif;" +
        "color:#18181b;padding:12px",
    });

    function sep() {
      return el("div", { style: "height:1px;background:#ececf0;margin:10px 0" });
    }

    // drag handle / title bar. The title slot is filled below: a stage
    // breadcrumb in the native app, a plain label on the web.
    var titleSlot = el("div", { style: "display:flex;align-items:center;gap:6px" });
    var bar = el(
      "div",
      {
        style:
          "display:flex;align-items:center;justify-content:space-between;" +
          "cursor:move;margin:-4px -4px 8px;padding:4px 4px 8px;border-bottom:1px solid #ececf0;user-select:none",
      },
      [
        titleSlot,
        el(
          "button",
          {
            title: "Close editor",
            onclick: unmount,
            style:
              "border:0;background:transparent;font-size:18px;line-height:1;cursor:pointer;color:#71717a",
          },
          ["×"]
        ),
      ]
    );
    makeDraggable(panel, bar);

    // ---- metadata section ----
    var metaFields = el("div", {
      id: NS + "-metafields",
      style: "display:none;margin-top:8px;gap:6px",
    });
    function field(label, key, type) {
      var input = el("input", {
        type: type || "text",
        value: state.meta[key] || "",
        style:
          "width:100%;box-sizing:border-box;border:1px solid #d4d4d8;border-radius:6px;padding:6px 8px;font:12px system-ui",
        oninput: function (e) {
          state.meta[key] = e.target.value;
          renderMeta();
        },
      });
      return el("label", { style: "display:grid;gap:3px;font-size:11px;color:#52525b" }, [
        label,
        input,
      ]);
    }
    metaFields.appendChild(field("Title", "title"));
    metaFields.appendChild(field("URL", "url"));
    metaFields.appendChild(field("Author", "author"));
    metaFields.appendChild(field("Access date", "accessDate", "date"));
    metaFields.appendChild(field("Notes", "notes"));

    var metaToggle = el(
      "label",
      { style: "display:flex;align-items:center;gap:8px;cursor:pointer;padding:2px 0" },
      [
        el("input", {
          type: "checkbox",
          onchange: function (e) {
            state.meta.show = e.target.checked;
            metaFields.style.display = e.target.checked ? "grid" : "none";
            renderMeta();
          },
        }),
        el("span", { style: "font-weight:600" }, ["Include metadata header"]),
      ]
    );

    // ---- remove section ----
    var removeBtn = el("button", {
      id: NS + "-removebtn",
      style: STYLE_BTN,
      "aria-pressed": "false",
      onclick: function () {
        setRemoveMode(!state.removeMode);
      },
    });
    removeBtn.textContent = "Remove elements";
    var removeRow = el("div", { style: "display:flex;gap:6px;align-items:center" }, [
      el("button", { style: STYLE_BTN + ";width:auto;flex:1", onclick: undo }, ["Undo"]),
      el("button", { style: STYLE_BTN + ";width:auto;flex:1", onclick: resetRemoved }, ["Reset"]),
    ]);
    var count = el("div", {
      id: NS + "-count",
      style: "font-size:11px;color:#71717a;text-align:right",
    });
    count.textContent = state.removed.length + " removed";
    var adblockUI = buildAdblock(isNative);

    // ---- font controls ----
    function slider(label, min, max, val, step, oninput, valfmt) {
      var out = el("span", { style: "font-variant-numeric:tabular-nums;color:#111" }, [
        valfmt(val),
      ]);
      var input = el("input", {
        type: "range",
        min: min,
        max: max,
        step: step,
        value: val,
        style: "width:100%",
        oninput: function (e) {
          out.textContent = valfmt(e.target.value);
          oninput(e.target.value);
        },
      });
      return el("div", { style: "display:grid;gap:4px" }, [
        el(
          "div",
          { style: "display:flex;justify-content:space-between;font-size:11px;color:#52525b" },
          [label, out]
        ),
        input,
      ]);
    }
    var baseBody = parseInt(getComputedStyle(document.body).fontSize || "16", 10) || 16;
    var bodySlider = slider("Body text", 12, 28, baseBody, 1, function (v) {
      state.bodyPx = parseInt(v, 10);
      render_style();
    }, function (v) { return v + "px"; });
    var lineSlider = slider("Line height", 1, 2.2, 1.6, 0.05, function (v) {
      state.lineHeight = parseFloat(v);
      render_style();
    }, function (v) { return parseFloat(v).toFixed(2); });
    var headSlider = slider("Heading size", 0.6, 2, 1, 0.05, function (v) {
      state.headingScale = parseFloat(v);
      render_style();
    }, function (v) { return Math.round(parseFloat(v) * 100) + "%"; });

    // ---- page & margins (US Letter) ----
    function marginInput(key) {
      return el("input", {
        type: "number", min: "0", max: "3", step: "0.05", value: state.margins[key],
        style:
          "width:100%;box-sizing:border-box;border:1px solid #d4d4d8;border-radius:6px;" +
          "padding:5px 6px;font:12px system-ui",
        oninput: function (e) {
          var v = parseFloat(e.target.value);
          state.margins[key] = isNaN(v) ? 0 : Math.max(0, Math.min(3, v));
          render_style();
        },
      });
    }
    function marginCell(label, key) {
      return el("label", { style: "display:grid;gap:2px;font-size:10px;color:#71717a" }, [
        label, marginInput(key),
      ]);
    }
    var marginGrid = el(
      "div",
      { style: "display:grid;grid-template-columns:1fr 1fr;gap:6px" },
      [
        marginCell("Top (in)", "top"),
        marginCell("Right (in)", "right"),
        marginCell("Bottom (in)", "bottom"),
        marginCell("Left (in)", "left"),
      ]
    );
    var pageLabel = el(
      "div",
      { style: "font-size:11px;color:#52525b;margin-bottom:6px;font-weight:600" },
      ["Page — US Letter (8.5 × 11 in) · margins"]
    );
    var guideToggle = el(
      "label",
      { style: "display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:8px;font-size:12px;color:#52525b" },
      [
        el("input", {
          type: "checkbox",
          onchange: function (e) {
            state.marginGuide = e.target.checked;
            render_style();
          },
        }),
        el("span", {}, ["Show margin guide"]),
      ]
    );

    // ---- header / footer / page numbers (stamped by the native renderer) ----
    function textField(label, key, placeholder) {
      return el("label", { style: "display:grid;gap:3px;font-size:11px;color:#52525b;margin-top:6px" }, [
        label,
        el("input", {
          type: "text",
          value: state[key] || "",
          placeholder: placeholder || "",
          style:
            "width:100%;box-sizing:border-box;border:1px solid #d4d4d8;border-radius:6px;padding:6px 8px;font:12px system-ui",
          oninput: function (e) { state[key] = e.target.value; },
        }),
      ]);
    }
    var hfLabel = el(
      "div",
      { style: "font-size:11px;font-weight:600;color:#52525b" },
      ["Header & footer"]
    );
    var headerField = textField("Header text", "header", "e.g. article title");
    var footerField = textField("Footer text", "footer", "e.g. source URL");
    var pageNumToggle = el(
      "label",
      { style: "display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:8px;font-size:12px;color:#52525b" },
      [
        el("input", {
          type: "checkbox",
          onchange: function (e) { state.pageNumbers = e.target.checked; },
        }),
        el("span", {}, ["Page numbers"]),
      ]
    );

    // ============================ WEB (flat, print) ============================
    if (!isNative) {
      titleSlot.appendChild(el("strong", { style: "font-size:13px" }, ["Prepare source"]));
      var saveBtn = el("button", { style: STYLE_PRIMARY, onclick: exportPdf }, ["Save as PDF"]);
      var hint = el(
        "div",
        { style: "font-size:11px;color:#a1a1aa;text-align:center;margin-top:6px" },
        ["Choose “Save as PDF” in the print dialog"]
      );
      panel.appendChild(bar);
      panel.appendChild(metaToggle);
      panel.appendChild(metaFields);
      panel.appendChild(sep());
      panel.appendChild(removeBtn);
      panel.appendChild(el("div", { style: "height:6px" }));
      panel.appendChild(removeRow);
      panel.appendChild(count);
      panel.appendChild(sep());
      panel.appendChild(adblockUI);
      panel.appendChild(sep());
      panel.appendChild(bodySlider);
      panel.appendChild(el("div", { style: "height:8px" }));
      panel.appendChild(lineSlider);
      panel.appendChild(el("div", { style: "height:8px" }));
      panel.appendChild(headSlider);
      panel.appendChild(sep());
      panel.appendChild(pageLabel);
      panel.appendChild(marginGrid);
      panel.appendChild(guideToggle);
      panel.appendChild(sep());
      panel.appendChild(saveBtn);
      panel.appendChild(hint);
      return panel;
    }

    // ===================== NATIVE (single window, two panes) =====================
    // Pane 1 (Edit): log in, remove elements, presets. Pane 2 (Format): fonts,
    // metadata, margins, header/footer, then Preview / Save. The page stays
    // loaded the whole time; export is a sentinel navigation on this webview.
    var presetsUI = buildPresets();

    var paneEdit = el("div", { id: NS + "-pane-edit" });
    var paneFormat = el("div", { id: NS + "-pane-format", style: "display:none" });

    // ---- stage breadcrumb (title bar): Link · Edit · Format --------------
    var CRUMB_ON = "color:#18181b;font-weight:700";
    var CRUMB_OFF = "color:#a1a1aa;font-weight:600";
    function crumb(label, onclick) {
      return el("a", {
        href: "#",
        style: "font-size:12px;text-decoration:none;cursor:pointer;" + CRUMB_OFF,
        onclick: function (e) { e.preventDefault(); onclick(); },
      }, [label]);
    }
    function crumbSep() {
      return el("span", { style: "color:#d4d4d8;font-size:11px" }, ["›"]);
    }
    var cLink = crumb("Link", function () { newUrl(); });
    var cEdit = crumb("Edit", function () { showPane("edit"); });
    var cFormat = crumb("Format", function () { showPane("format"); });
    titleSlot.appendChild(cLink);
    titleSlot.appendChild(crumbSep());
    titleSlot.appendChild(cEdit);
    titleSlot.appendChild(crumbSep());
    titleSlot.appendChild(cFormat);

    // Switch panes and reflect it in the breadcrumb + the on-page preview.
    function showPane(name) {
      var editing = name === "edit";
      paneEdit.style.display = editing ? "" : "none";
      paneFormat.style.display = editing ? "none" : "";
      if (editing) setRemoveMode(false);
      cEdit.style.cssText = "font-size:12px;text-decoration:none;cursor:pointer;" + (editing ? CRUMB_ON : CRUMB_OFF);
      cFormat.style.cssText = "font-size:12px;text-decoration:none;cursor:pointer;" + (editing ? CRUMB_OFF : CRUMB_ON);
      // The Format stage shows the real rendered PDF inline; Edit hides it so
      // the live page is interactive again for logging in / removing clutter.
      state.previewMode = !editing;
      if (editing) closePreview();
      else openPreview();
      panel.scrollTop = 0;
    }

    var nextBtn = el("button", {
      style: STYLE_PRIMARY, onclick: function () { showPane("format"); },
    }, ["Next: Format →"]);
    var previewBtn = el("button", {
      style: STYLE_BTN + ";text-align:center", onclick: function () { requestPreview(); },
    }, ["↻ Refresh preview"]);
    var saveNativeBtn = el("button", {
      style: STYLE_PRIMARY, onclick: function () { nativeExport("save"); },
    }, ["Save PDF"]);

    // Pane 1 (Edit)
    paneEdit.appendChild(removeBtn);
    paneEdit.appendChild(el("div", { style: "height:6px" }));
    paneEdit.appendChild(removeRow);
    paneEdit.appendChild(count);
    paneEdit.appendChild(sep());
    paneEdit.appendChild(adblockUI);
    paneEdit.appendChild(sep());
    paneEdit.appendChild(presetsUI);
    paneEdit.appendChild(sep());
    paneEdit.appendChild(nextBtn);

    // Pane 2 (Format)
    paneFormat.appendChild(metaToggle);
    paneFormat.appendChild(metaFields);
    paneFormat.appendChild(sep());
    paneFormat.appendChild(bodySlider);
    paneFormat.appendChild(el("div", { style: "height:8px" }));
    paneFormat.appendChild(lineSlider);
    paneFormat.appendChild(el("div", { style: "height:8px" }));
    paneFormat.appendChild(headSlider);
    paneFormat.appendChild(sep());
    paneFormat.appendChild(pageLabel);
    paneFormat.appendChild(marginGrid);
    paneFormat.appendChild(guideToggle);
    paneFormat.appendChild(sep());
    paneFormat.appendChild(hfLabel);
    paneFormat.appendChild(headerField);
    paneFormat.appendChild(footerField);
    paneFormat.appendChild(pageNumToggle);
    paneFormat.appendChild(sep());
    paneFormat.appendChild(previewBtn);
    paneFormat.appendChild(el("div", { style: "height:6px" }));
    paneFormat.appendChild(saveNativeBtn);

    panel.appendChild(bar);
    panel.appendChild(paneEdit);
    panel.appendChild(paneFormat);
    // Start on Edit (sets the breadcrumb highlight; preview off).
    showPane("edit");
    return panel;
  }

  // Presets section (native only). Returns a container element.
  function buildPresets() {
    var box = el("div");
    var presets = Array.isArray(window.__WWWPDF_PRESETS) ? window.__WWWPDF_PRESETS : [];
    var hostKey = function (h) { return (h || "").replace(/^www\./, ""); };
    var NO_PRESET = "";

    var presetSel = el("select", {
      id: NS + "-preset-sel",
      style:
        "width:100%;box-sizing:border-box;border:1px solid #d4d4d8;border-radius:7px;" +
        "padding:7px 8px;font:12px system-ui;background:#fff;color:#18181b",
      onchange: function () {
        refreshUpdateLink();
        var p = currentPreset();
        if (p) applyPreset(p);
      },
    });
    function sortedPresets() {
      var here = hostKey(location.hostname);
      return presets.slice().sort(function (a, b) {
        var am = hostKey(a.host) === here ? 0 : 1;
        var bm = hostKey(b.host) === here ? 0 : 1;
        if (am !== bm) return am - bm;
        return a.name < b.name ? -1 : 1;
      });
    }
    function rebuildPresetOptions() {
      var keep = presetSel.value;
      presetSel.textContent = "";
      var here = hostKey(location.hostname);
      var none = document.createElement("option");
      none.value = NO_PRESET;
      none.textContent = "No Preset";
      presetSel.appendChild(none);
      sortedPresets().forEach(function (p) {
        var o = document.createElement("option");
        o.value = p.id;
        o.textContent = (hostKey(p.host) === here ? "★ " : "") + p.name;
        presetSel.appendChild(o);
      });
      presetSel.value = presets.some(function (p) { return p.id === keep; }) ? keep : NO_PRESET;
    }
    function currentPreset() {
      var id = presetSel.value;
      for (var i = 0; i < presets.length; i++) if (presets[i].id === id) return presets[i];
      return null;
    }
    function currentSelectors() {
      var sels = [];
      state.removed.forEach(function (r) {
        if (r.sel && sels.indexOf(r.sel) < 0) sels.push(r.sel);
      });
      return sels;
    }
    function presetNav(params) {
      window.location.href = "https://" + PRESET_HOST + "/?" + params;
    }

    var nameInput = el("input", {
      type: "text", placeholder: "New preset name", value: hostKey(location.hostname),
      style:
        "width:100%;box-sizing:border-box;border:1px solid #d4d4d8;border-radius:7px;" +
        "padding:7px 8px;font:12px system-ui",
    });
    var saveBtn = el("button", {
      style: STYLE_BTN + ";width:auto;flex:none;text-align:center",
      onclick: function () {
        var sels = currentSelectors();
        if (!sels.length) return toast("Click some elements to remove first");
        var name = (nameInput.value || "").trim() || hostKey(location.hostname);
        presetNav(
          "action=save&name=" + encodeURIComponent(name) +
          "&host=" + encodeURIComponent(location.hostname) +
          "&sels=" + encodeURIComponent(JSON.stringify(sels))
        );
      },
    }, ["Save new"]);
    var deleteBtn = el("button", {
      style: STYLE_BTN + ";text-align:center;color:#dc2626",
      onclick: function () {
        var p = currentPreset();
        if (!p) return toast("Select a preset to delete");
        presetNav("action=delete&id=" + encodeURIComponent(p.id));
      },
    }, ["Delete selected"]);
    var editorBox = el("div", {
      id: NS + "-preset-editor",
      style: "display:none;gap:6px;flex-direction:column;margin-top:8px",
    }, [
      el("div", { style: "display:flex;gap:6px" }, [nameInput, saveBtn]),
      deleteBtn,
    ]);

    var LINK_STYLE = "font:11px system-ui;color:#2563eb;text-decoration:none;cursor:pointer";
    var editorOpen = false;
    var editLink = el("a", {
      href: "#", style: LINK_STYLE,
      onclick: function (e) {
        e.preventDefault();
        editorOpen = !editorOpen;
        editorBox.style.display = editorOpen ? "flex" : "none";
        editLink.textContent = editorOpen ? "Hide preset editor" : "Edit Presets";
      },
    }, ["Edit Presets"]);
    var updateLink = el("a", {
      href: "#", style: LINK_STYLE,
      onclick: function (e) {
        e.preventDefault();
        var p = currentPreset();
        if (!p) return;
        var sels = currentSelectors();
        if (!sels.length) return toast("Nothing removed to save");
        presetNav("action=update&id=" + encodeURIComponent(p.id) +
          "&sels=" + encodeURIComponent(JSON.stringify(sels)));
      },
    });
    function refreshUpdateLink() {
      var p = currentPreset();
      if (p) { updateLink.textContent = "Update " + p.name; updateLink.style.display = ""; }
      else { updateLink.style.display = "none"; }
    }
    var linkRow = el("div", {
      style: "display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:8px",
    }, [editLink, updateLink]);

    rebuildPresetOptions();
    refreshUpdateLink();
    window.wwwToPdf.presetsUpdated = function (list) {
      presets = Array.isArray(list) ? list : [];
      rebuildPresetOptions();
      refreshUpdateLink();
    };

    box.appendChild(presetSel);
    box.appendChild(linkRow);
    box.appendChild(editorBox);
    return box;
  }

  function makeDraggable(panel, handle) {
    var sx, sy, sr, st, dragging = false;
    handle.addEventListener("mousedown", function (e) {
      if (e.target.tagName === "BUTTON") return;
      dragging = true;
      sx = e.clientX;
      sy = e.clientY;
      var r = panel.getBoundingClientRect();
      sr = window.innerWidth - r.right;
      st = r.top;
      e.preventDefault();
    });
    window.addEventListener("mousemove", function (e) {
      if (!dragging) return;
      var right = Math.max(0, sr - (e.clientX - sx));
      var top = Math.max(0, st + (e.clientY - sy));
      panel.style.right = right + "px";
      panel.style.top = top + "px";
      state.panelPos = { right: right, top: top };
    });
    window.addEventListener("mouseup", function () {
      dragging = false;
    });
  }

  // ---- export / navigation (native single-window) --------------------------
  // Everything native travels over sentinel navigations: the remote page has
  // no working Tauri IPC, but a navigation the Rust `on_navigation` hook can
  // cancel (leaving the page untouched) is a reliable one-way channel.
  //   wwwtopdf.export?action=save|preview&…  -> render this webview to a PDF
  //   wwwtopdf.home                          -> go back to URL entry
  //   wwwtopdf.preset?action=…               -> persist a preset
  //   wwwtopdf.adblock?action=refresh        -> recompute ad filters for this page
  var EXPORT_HOST = "wwwtopdf.export";
  var HOME_HOST = "wwwtopdf.home";
  var PRESET_HOST = "wwwtopdf.preset";
  var ADBLOCK_HOST = "wwwtopdf.adblock";

  // Fonts/metadata already live in the page DOM (createPDF captures them);
  // only margins + header/footer/page-numbers + filename need to reach Rust.
  function nativeExport(action) {
    var m = state.margins;
    var q =
      "action=" + action +
      "&title=" + encodeURIComponent(state.meta.title || document.title || "") +
      "&mt=" + m.top + "&mr=" + m.right + "&mb=" + m.bottom + "&ml=" + m.left +
      "&header=" + encodeURIComponent(state.header || "") +
      "&footer=" + encodeURIComponent(state.footer || "") +
      "&pagenum=" + (state.pageNumbers ? "1" : "0");
    // Preview shows its status in the overlay; only save needs a toast.
    if (action !== "preview") toast("Rendering PDF…");
    setTimeout(function () {
      window.location.href = "https://" + EXPORT_HOST + "/?" + q;
    }, 30);
  }
  function newUrl() {
    window.location.href = "https://" + HOME_HOST + "/";
  }
  // Called by Rust (via eval) after a render completes.
  function afterExport(ok, message) {
    // A failed preview render surfaces in the overlay it was rendering into,
    // not the toast (the overlay is already the user's focus).
    var wasPreview = _pvPending;
    _pvPending = false;
    if (!ok && wasPreview && previewOverlay()) {
      previewStatus("Preview failed: " + message);
      return;
    }
    toast((ok ? "" : "PDF failed: ") + message);
  }

  // ---- inline PDF preview (native Format stage) ----------------------------
  // The real rendered PDF is streamed here from Rust as base64 (chunked so each
  // eval stays small) and drawn to <canvas> with pdf.js — no <embed>/<iframe>
  // and no Web Worker, so even a strict site CSP can't block it. Rust injects
  // pdf.min.js + pdf.worker.min.js before the first chunk arrives.
  var _pvBuf = "";
  var _pvPending = false;

  function previewOverlay() {
    return document.getElementById(NS + "-preview");
  }
  function previewStatus(msg) {
    var ov = previewOverlay();
    if (!ov) return;
    var pages = document.getElementById(NS + "-preview-pages");
    if (pages) pages.textContent = "";
    var s = el(
      "div",
      {
        style:
          "margin:auto;padding:48px 24px;text-align:center;" +
          "color:#e4e4e7;font:14px system-ui,-apple-system,sans-serif",
      },
      [msg]
    );
    (pages || ov).appendChild(s);
  }
  // Open the overlay and kick off a render. Called when the Format stage opens.
  function openPreview() {
    var ov = previewOverlay();
    if (!ov) {
      ov = el("div", {
        id: NS + "-preview",
        style:
          // Above the metadata header (2147483645) — which otherwise floats
          // over the preview — but below the panel and toast (2147483647).
          "position:fixed;inset:0;z-index:2147483646;background:#3f3f46;" +
          "overflow:auto;-webkit-overflow-scrolling:touch;padding:28px 0",
      });
      ov.appendChild(
        el("div", {
          id: NS + "-preview-pages",
          style:
            "display:flex;flex-direction:column;align-items:center;gap:20px;" +
            "min-height:100%;box-sizing:border-box",
        })
      );
      document.body.appendChild(ov);
    }
    requestPreview();
  }
  function closePreview() {
    var ov = previewOverlay();
    if (ov) ov.remove();
    _pvBuf = "";
    _pvPending = false;
  }
  // Re-render the current settings into the (already open) overlay.
  function requestPreview() {
    if (!previewOverlay()) return;
    previewStatus("Rendering PDF…");
    _pvPending = true;
    nativeExport("preview");
  }

  // Chunk protocol driven by Rust: __pvBegin, then N × __pvChunk, then __pvEnd.
  function pvBegin() {
    _pvBuf = "";
    _pvPending = false; // bytes are on the way — the render itself succeeded
    previewStatus("Rendering PDF…");
  }
  function pvChunk(s) {
    _pvBuf += s;
  }
  function pvEnd() {
    var b64 = _pvBuf;
    _pvBuf = "";
    var bytes;
    try {
      var bin = atob(b64);
      bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } catch (e) {
      previewStatus("Could not decode the preview.");
      return;
    }
    renderPreviewDoc(bytes);
  }
  function renderPreviewDoc(bytes) {
    var ov = previewOverlay();
    if (!ov) return; // the user left the Format stage before bytes arrived
    var lib = window.pdfjsLib;
    if (!lib || !lib.getDocument) {
      previewStatus("Preview engine unavailable.");
      return;
    }
    var pages = document.getElementById(NS + "-preview-pages");
    lib
      .getDocument({ data: bytes })
      .promise.then(function (doc) {
        if (!previewOverlay()) return;
        pages.textContent = "";
        var dpr = window.devicePixelRatio || 1;
        var avail = Math.max(200, ov.clientWidth - 56);
        var maxW = Math.min(avail, 900);
        // Render pages sequentially to keep peak memory down on long docs.
        var chain = Promise.resolve();
        var _loop = function (num) {
          chain = chain.then(function () {
            if (!previewOverlay()) return;
            return doc.getPage(num).then(function (page) {
              var vp1 = page.getViewport({ scale: 1 });
              var scale = maxW / vp1.width;
              var cssW = Math.round(vp1.width * scale);
              var cssH = Math.round(vp1.height * scale);
              var canvas = el("canvas", {
                style:
                  "background:#fff;box-shadow:0 2px 20px rgba(0,0,0,.45);" +
                  "width:" + cssW + "px;height:" + cssH + "px;max-width:100%",
              });
              var vp = page.getViewport({ scale: scale * dpr });
              canvas.width = Math.round(vp.width);
              canvas.height = Math.round(vp.height);
              pages.appendChild(canvas);
              return page.render({
                canvasContext: canvas.getContext("2d"),
                viewport: vp,
              }).promise;
            });
          });
        };
        for (var n = 1; n <= doc.numPages; n++) _loop(n);
        return chain;
      })
      .catch(function (e) {
        previewStatus("Preview failed: " + (e && e.message ? e.message : e));
      });
  }

  function exportPdf() {
    // If a host wants to drive export itself, let it.
    if (window.wwwToPdf && typeof window.wwwToPdf.onExport === "function") {
      var handled = window.wwwToPdf.onExport(collect());
      if (handled === true) return;
    }
    // Web path: the browser's print dialog (choose "Save as PDF"). Print with
    // the hidden elements physically absent — the dialog snapshots the DOM,
    // and a site's own display:block!important rules can't resurrect what
    // isn't in the document. Restored as soon as the snapshot is taken
    // (print() blocks while the dialog is open; afterprint is the backup for
    // engines where it doesn't).
    detachForCapture();
    var restore = function () {
      window.removeEventListener("afterprint", restore);
      reattachAfterCapture();
    };
    window.addEventListener("afterprint", restore);
    try {
      window.focus();
      window.print();
    } finally {
      restore();
    }
  }

  function toast(msg) {
    var t = document.getElementById(NS + "-toast");
    if (!t) {
      t = el("div", {
        id: NS + "-toast",
        style:
          "position:fixed;left:50%;bottom:22px;transform:translateX(-50%);" +
          "z-index:2147483647;max-width:80vw;background:#111;color:#fff;" +
          "padding:11px 16px;border-radius:10px;font:13px system-ui;" +
          "box-shadow:0 8px 30px rgba(0,0,0,.35);white-space:pre-wrap;" +
          "word-break:break-all;text-align:center",
      });
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = "1";
    clearTimeout(t._timer);
    t._timer = setTimeout(function () {
      t.style.transition = "opacity .4s";
      t.style.opacity = "0";
    }, 5000);
  }
  function collect() {
    return {
      meta: JSON.parse(JSON.stringify(state.meta)),
      removedCount: state.removed.length,
      bodyPx: state.bodyPx,
      headingScale: state.headingScale,
    };
  }

  // On iOS the safe-area insets (home indicator / notch) only resolve if the
  // page opts into them via viewport-fit=cover. Most responsive sites already
  // ship a viewport meta — append to it. Never create one where none exists,
  // which could reflow a desktop-only site. No-op off the native app.
  function ensureSafeAreaViewport() {
    if (!window.__TAURI_INTERNALS__) return;
    var mv = document.querySelector('meta[name="viewport"]');
    if (!mv || /viewport-fit\s*=/.test(mv.content)) return;
    mv.content = mv.content.trim() + (mv.content.trim() ? ", " : "") + "viewport-fit=cover";
  }

  // ---- mount / unmount -----------------------------------------------------
  function mount(options) {
    options = options || {};
    if (options.meta) {
      Object.keys(options.meta).forEach(function (k) {
        state.meta[k] = options.meta[k];
      });
    }
    // As a native init script this file evaluates at document-start, before
    // <title> is parsed — so the parse-time default is always "". Fill it in
    // now (mount runs at DOMContentLoaded, when the title exists).
    if (!state.meta.title) state.meta.title = document.title || "";
    ensureStyle();
    ensureSafeAreaViewport();
    renderMeta();
    if (!document.getElementById(NS + "-panel")) {
      document.body.appendChild(buildPanel());
      document.addEventListener("mouseover", onOver, true);
      document.addEventListener("mouseout", onOut, true);
      document.addEventListener("click", onClick, true);
    }
    // Ad filters: the native engine may have pushed a set before the editor
    // mounted (Rust stashes it on __WWWPDF_ADBLOCK); otherwise start with the
    // built-in fallback list. A later engine push replaces it.
    if (!state.adblock.selectors.length) {
      var pushed = Array.isArray(window.__WWWPDF_ADBLOCK) ? window.__WWWPDF_ADBLOCK : null;
      setAdblockSelectors(pushed || BUILTIN_AD_SELECTORS, pushed ? "engine" : "builtin");
    }
    ensureEnforcer();
    window.wwwToPdf.__mounted = true;
    return window.wwwToPdf;
  }
  function unmount() {
    setRemoveMode(false);
    closePreview();
    stopEnforcer();
    captureThaw();
    document.removeEventListener("mouseover", onOver, true);
    document.removeEventListener("mouseout", onOut, true);
    document.removeEventListener("click", onClick, true);
    var p = document.getElementById(NS + "-panel");
    if (p) p.remove();
    window.wwwToPdf.__mounted = false;
  }

  window.wwwToPdf = window.wwwToPdf || {};
  window.wwwToPdf.mount = mount;
  window.wwwToPdf.unmount = unmount;
  window.wwwToPdf.state = state;
  window.wwwToPdf.toast = toast; // native side calls this for progress/errors
  window.wwwToPdf.afterExport = afterExport; // native side reports render result
  // Inline-preview chunk protocol, driven from Rust after a preview render.
  window.wwwToPdf.__pvBegin = pvBegin;
  window.wwwToPdf.__pvChunk = pvChunk;
  window.wwwToPdf.__pvEnd = pvEnd;
  // Ad blocking: Rust pushes the engine-computed selector set for this URL.
  window.wwwToPdf.setAdblockSelectors = function (list) {
    setAdblockSelectors(list, "engine");
  };
  // Capture window: Rust freezes the page's JS before the pre-capture reflow
  // and thaws it once the PDF bytes exist. Exposed for the capture scripts.
  window.wwwToPdf.__captureFreeze = captureFreeze;
  window.wwwToPdf.__captureThaw = captureThaw;
  window.wwwToPdf.__enforceRemovals = enforceRemovals;

  // The single native webview also shows our own app UI (the URL-entry page),
  // which sets __WWWPDF_IS_APP. Don't mount the editor there.
  function shouldAutoMount() {
    return !window.__WWWTOPDF_NO_AUTOMOUNT && !window.__WWWPDF_IS_APP;
  }
  if (shouldAutoMount()) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", function () {
        if (shouldAutoMount()) mount();
      });
    } else {
      mount();
    }
  }
})();
