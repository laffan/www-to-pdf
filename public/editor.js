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
    headingScale: 1,
    // US Letter output; margins in inches.
    margins: { top: 1, right: 1, bottom: 1, left: 1 },
    marginGuide: false,
    meta: {
      title: document.title || "",
      url: location.href,
      author: "",
      accessDate: new Date().toISOString().slice(0, 10),
      notes: "",
      show: false,
    },
    panelPos: { right: 16, top: 16 },
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
    var bodyRule = state.bodyPx
      ? "body, p, li, td, th, blockquote, dd, dt { font-size:" +
        state.bodyPx +
        "px !important; line-height:1.6 !important; }"
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
    // @page drives the browser print path (web build) and any print-based
    // native path; US Letter with the user's margins.
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
    t.classList.add(NS + "-removed");
    state.removed.push(t);
    updateCounts();
  }
  function panelContains(node) {
    var p = document.getElementById(NS + "-panel");
    return p && (node === p || p.contains(node));
  }
  function setRemoveMode(on) {
    state.removeMode = on;
    document.getElementById(NS + "-removebtn").setAttribute("aria-pressed", on);
    document.getElementById(NS + "-removebtn").textContent = on
      ? "● Click elements to remove"
      : "Remove elements";
    if (!on) onOut();
  }
  function undo() {
    var t = state.removed.pop();
    if (t) t.classList.remove(NS + "-removed");
    updateCounts();
  }
  function resetRemoved() {
    state.removed.forEach(function (t) {
      t.classList.remove(NS + "-removed");
    });
    state.removed = [];
    updateCounts();
  }
  function updateCounts() {
    var c = document.getElementById(NS + "-count");
    if (c) c.textContent = state.removed.length + " removed";
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

    // drag handle / title bar
    var bar = el(
      "div",
      {
        style:
          "display:flex;align-items:center;justify-content:space-between;" +
          "cursor:move;margin:-4px -4px 8px;padding:4px 4px 8px;border-bottom:1px solid #ececf0;user-select:none",
      },
      [
        el("strong", { style: "font-size:13px" }, ["www → pdf"]),
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

    // metadata section
    var metaFields = el("div", {
      id: NS + "-metafields",
      style: "display:none;margin-top:8px;display:grid;gap:6px",
    });
    metaFields.style.display = "none";
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

    // remove section
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
      el(
        "button",
        { style: STYLE_BTN + ";width:auto;flex:1", onclick: undo },
        ["Undo"]
      ),
      el(
        "button",
        { style: STYLE_BTN + ";width:auto;flex:1", onclick: resetRemoved },
        ["Reset"]
      ),
    ]);
    var count = el("div", {
      id: NS + "-count",
      style: "font-size:11px;color:#71717a;text-align:right",
    });
    count.textContent = "0 removed";

    // Native app (stage 2): the page is for logging in and adding/removing
    // material only. Fonts, metadata, and margins live in the PDF-settings
    // window (stage 3), which previews the real generated PDF.
    if (window.__TAURI_INTERNALS__) {
      var nextBtn = el(
        "button",
        { style: STYLE_PRIMARY, onclick: gotoStage3 },
        ["Next: PDF settings →"]
      );
      var divider = function () {
        return el("div", { style: "height:1px;background:#ececf0;margin:10px 0" });
      };
      panel.appendChild(bar);
      panel.appendChild(removeBtn);
      panel.appendChild(el("div", { style: "height:6px" }));
      panel.appendChild(removeRow);
      panel.appendChild(count);
      panel.appendChild(divider());
      panel.appendChild(nextBtn);
      return panel;
    }

    // font controls
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
          {
            style:
              "display:flex;justify-content:space-between;font-size:11px;color:#52525b",
          },
          [label, out]
        ),
        input,
      ]);
    }
    var baseBody = parseInt(
      getComputedStyle(document.body).fontSize || "16",
      10
    ) || 16;
    var bodySlider = slider(
      "Body text",
      12,
      28,
      baseBody,
      1,
      function (v) {
        state.bodyPx = parseInt(v, 10);
        render_style();
      },
      function (v) {
        return v + "px";
      }
    );
    var headSlider = slider(
      "Heading size",
      0.6,
      2,
      1,
      0.05,
      function (v) {
        state.headingScale = parseFloat(v);
        render_style();
      },
      function (v) {
        return Math.round(parseFloat(v) * 100) + "%";
      }
    );

    // page & margins (output is US Letter, 8.5 x 11 in)
    function marginInput(key) {
      return el("input", {
        type: "number",
        min: "0",
        max: "3",
        step: "0.05",
        value: state.margins[key],
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
        label,
        marginInput(key),
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

    // save
    var saveBtn = el(
      "button",
      { style: STYLE_PRIMARY, onclick: exportPdf },
      ["Save as PDF"]
    );
    var hint = el(
      "div",
      { style: "font-size:11px;color:#a1a1aa;text-align:center;margin-top:6px" },
      ["Choose “Save as PDF” in the print dialog"]
    );

    function sep() {
      return el("div", { style: "height:1px;background:#ececf0;margin:10px 0" });
    }

    panel.appendChild(bar);
    panel.appendChild(metaToggle);
    panel.appendChild(metaFields);
    panel.appendChild(sep());
    panel.appendChild(removeBtn);
    panel.appendChild(el("div", { style: "height:6px" }));
    panel.appendChild(removeRow);
    panel.appendChild(count);
    panel.appendChild(sep());
    panel.appendChild(bodySlider);
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

  // ---- stage hand-off / export ---------------------------------------------
  // Sentinel host used to signal the native app that stage 2 (DOM editing) is
  // done. The Rust `on_navigation` handler recognises it, cancels the
  // navigation (the page is untouched), and opens the PDF-settings window.
  // Sentinel navigation avoids the Tauri IPC ACL entirely, which is unreliable
  // for dynamically-created remote webviews.
  var STAGE3_HOST = "wwwtopdf.stage3";

  function gotoStage3() {
    setRemoveMode(false);
    var q =
      "title=" + encodeURIComponent(document.title || "") +
      "&url=" + encodeURIComponent(state.meta.url || location.href);
    window.location.href = "https://" + STAGE3_HOST + "/?" + q;
  }

  // Applied by the PDF-settings window (via native eval) — fonts and metadata
  // must live in the page's own DOM so they show up in the rendered PDF.
  function applySettings(s) {
    if (!s) return;
    if (typeof s.bodyPx === "number") state.bodyPx = s.bodyPx;
    else if (s.bodyPx === null) state.bodyPx = null;
    if (typeof s.headingScale === "number") state.headingScale = s.headingScale;
    if (s.margins) {
      ["top", "right", "bottom", "left"].forEach(function (k) {
        if (typeof s.margins[k] === "number") state.margins[k] = s.margins[k];
      });
    }
    if (s.meta) {
      Object.keys(s.meta).forEach(function (k) {
        state.meta[k] = s.meta[k];
      });
    }
    render_style();
    renderMeta();
  }

  function exportPdf() {
    // If a host wants to drive export itself, let it.
    if (window.wwwToPdf && typeof window.wwwToPdf.onExport === "function") {
      var handled = window.wwwToPdf.onExport(collect());
      if (handled === true) return;
    }
    // Web path: the browser's print dialog (choose "Save as PDF").
    window.focus();
    window.print();
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

  // ---- mount / unmount -----------------------------------------------------
  function mount(options) {
    options = options || {};
    if (options.meta) {
      Object.keys(options.meta).forEach(function (k) {
        state.meta[k] = options.meta[k];
      });
    }
    ensureStyle();
    renderMeta();
    if (!document.getElementById(NS + "-panel")) {
      document.body.appendChild(buildPanel());
      document.addEventListener("mouseover", onOver, true);
      document.addEventListener("mouseout", onOut, true);
      document.addEventListener("click", onClick, true);
    }
    window.wwwToPdf.__mounted = true;
    return window.wwwToPdf;
  }
  function unmount() {
    setRemoveMode(false);
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
  window.wwwToPdf.applySettings = applySettings;

  if (!window.__WWWTOPDF_NO_AUTOMOUNT) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", function () {
        mount();
      });
    } else {
      mount();
    }
  }
})();
