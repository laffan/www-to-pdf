// Functional smoke test for the editor engine, driven in a real browser.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const EDITOR = readFileSync(new URL("../public/editor.js", import.meta.url), "utf8");
const SAMPLE = `<!doctype html><html><head><title>Sample Article</title></head>
<body style="font-size:16px">
  <nav id="nav">NAVIGATION</nav>
  <h1>Big Heading</h1>
  <p id="para">Some body text that we will resize.</p>
  <footer id="foot">FOOTER</footer>
</body></html>`;

// Use a system/preinstalled Chromium if PW_CHROME is set, else Playwright's own.
const launchOpts = { args: ["--no-sandbox"] };
if (process.env.PW_CHROME) launchOpts.executablePath = process.env.PW_CHROME;
const browser = await chromium.launch(launchOpts);
const page = await browser.newPage();
await page.setContent(SAMPLE, { waitUntil: "load" });
await page.addScriptTag({ content: EDITOR });

const results = [];
const check = (name, cond) => results.push([name, !!cond]);

// 1. toolbar mounts
check("panel mounts", await page.$("#wwwpdf-panel"));

// 2. remove-mode hides a clicked element
await page.evaluate(() => {
  window.wwwToPdf.state.removeMode = true;
});
await page.click("#nav");
check("clicked element removed", await page.evaluate(() =>
  document.getElementById("nav").classList.contains("wwwpdf-removed")
));
check(
  "removed element is display:none",
  await page.evaluate(
    () => getComputedStyle(document.getElementById("nav")).display === "none"
  )
);
check("removal records a selector that resolves back to the element", await page.evaluate(() => {
  const r = window.wwwToPdf.state.removed[0];
  return !!r && !!r.sel && document.querySelector(r.sel) === r.el;
}));

// 3. body font size applies
await page.evaluate(() => {
  window.wwwToPdf.state.bodyPx = 24;
  document.getElementById("wwwpdf-style").textContent; // touch
});
await page.evaluate(() => {
  // re-render style via internal path: mount() re-renders
  const s = document.getElementById("wwwpdf-style");
  window.wwwToPdf.mount(); // no-op remount keeps state
});
// trigger render_style through the slider path is internal; set + re-render:
await page.evaluate(() => {
  const ev = new Event("input");
  const range = document.querySelector('#wwwpdf-panel input[type=range]');
  range.value = 24;
  range.dispatchEvent(ev);
});
check("body font resized to 24px", await page.evaluate(() =>
  Math.round(parseFloat(getComputedStyle(document.getElementById("para")).fontSize)) === 24
));

// 4. metadata header renders when enabled
await page.evaluate(() => {
  const cb = document.querySelector('#wwwpdf-panel input[type=checkbox]');
  cb.checked = true;
  cb.dispatchEvent(new Event("change"));
});
check("metadata header visible", await page.evaluate(() => {
  const m = document.getElementById("wwwpdf-meta");
  return m && getComputedStyle(m).display !== "none";
}));

// 5. margins: default @page is US Letter w/ 1in margins, and edits update it
check("default @page is US Letter, 1in margins", await page.evaluate(() =>
  document.getElementById("wwwpdf-style").textContent
    .includes("@page{size:8.5in 11in;margin:1in 1in 1in 1in;}")
));
await page.evaluate(() => {
  const top = document.querySelector('#wwwpdf-panel input[type=number]'); // first = Top
  top.value = "0.5";
  top.dispatchEvent(new Event("input"));
});
check("margin edit updates @page", await page.evaluate(() =>
  document.getElementById("wwwpdf-style").textContent.includes("margin:0.5in 1in 1in 1in;")
));

// 6. metadata header: sans-serif, no horizontal padding, survives hostile CSS
check("metadata is sans-serif", await page.evaluate(() => {
  const m = document.getElementById("wwwpdf-meta");
  return m && !/georgia|times/i.test(getComputedStyle(m).fontFamily);
}));
check("metadata has no horizontal padding", await page.evaluate(() => {
  const cs = getComputedStyle(document.getElementById("wwwpdf-meta"));
  return cs.paddingLeft === "0px" && cs.paddingRight === "0px";
}));
check("metadata survives hostile site CSS", await page.evaluate(() => {
  const hostile = document.createElement("style");
  hostile.textContent = "body > div { display:none; font-family: Georgia !important; }";
  document.head.appendChild(hostile);
  const cs = getComputedStyle(document.getElementById("wwwpdf-meta"));
  return cs.display !== "none" && !/georgia/i.test(cs.fontFamily);
}));

// 7. line-height slider (second range in the web panel) applies to the DOM
await page.evaluate(() => {
  const ranges = document.querySelectorAll('#wwwpdf-panel input[type=range]');
  ranges[1].value = 2.0; // 0=body, 1=line height, 2=heading
  ranges[1].dispatchEvent(new Event("input"));
});
check("line-height slider applies", await page.evaluate(() => {
  const p = document.getElementById("para");
  const lh = parseFloat(getComputedStyle(p).lineHeight);
  const fs = parseFloat(getComputedStyle(p).fontSize);
  return Math.abs(lh / fs - 2.0) < 0.05;
}));

// 8. unmount removes the panel
await page.evaluate(() => window.wwwToPdf.unmount());
check("unmount removes panel", await page.evaluate(() => !document.getElementById("wwwpdf-panel")));

// 9. Capture-measurement script (extracted VERBATIM from lib.rs): must report
// per-LINE break candidates so page cuts never split a text line.
{
  const librs = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  const m = librs.match(/CAPTURE_PREP_JS: &str = r#"([\s\S]*?)"#;/);
  check("capture script found in lib.rs", !!m);
  if (m) {
    const measPage = await browser.newPage();
    // A 300px-wide column forces a long paragraph to wrap into many lines.
    await measPage.setContent(
      `<div id="wwwpdf-panel">TOOLBAR</div>
       <div style="width:300px">
         <p id="longp" style="line-height:1.6">${"lorem ipsum dolor sit amet ".repeat(80)}</p>
         <img width="100" height="50" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" />
       </div>`,
      { waitUntil: "load" }
    );
    const res = JSON.parse(await measPage.evaluate(m[1]));
    const lineCount = await measPage.evaluate(() => {
      const r = document.createRange();
      r.selectNodeContents(document.getElementById("longp").firstChild);
      return r.getClientRects().length;
    });
    check("measures document height", res.h > 0 && res.w > 0);
    check(
      `reports per-line breaks (${res.b.length} candidates for ${lineCount} lines)`,
      lineCount > 10 && res.b.length >= lineCount
    );
    check("breaks are sorted ascending", res.b.every((v, i, a) => i === 0 || a[i - 1] <= v));
    check("hides the toolbar during capture", await measPage.evaluate(() =>
      getComputedStyle(document.getElementById("wwwpdf-panel")).display === "none"
    ));
    // Max gap between consecutive candidates inside the paragraph must be
    // about one line-height — that's what guarantees no mid-line cuts.
    const gaps = res.b.slice(1).map((v, i) => v - res.b[i]);
    const maxGapInText = Math.max(...gaps.slice(0, lineCount - 2));
    check(`line candidates are dense (max gap ${maxGapInText}px)`, maxGapInText <= 40);
    await measPage.close();
  }
}

// 10. Tauri mode: stage-2 panel is remove-tools + presets + Next
const page2 = await browser.newPage();
// Capture preset save/delete sentinel navigations instead of failing them.
let presetNavUrl = null;
await page2.route("https://wwwtopdf.preset/**", (route) => {
  presetNavUrl = route.request().url();
  route.abort("aborted");
});
await page2.setContent(SAMPLE, { waitUntil: "load" });
await page2.evaluate(() => {
  window.__TAURI_INTERNALS__ = {};
  window.__WWWPDF_PRESETS = [
    { id: "p2", name: "Another site", host: "other.example", selectors: [".zzz"] },
    { id: "p1", name: "Kill nav+footer", host: location.hostname, selectors: ["#nav", "#foot"] },
  ];
});
// Capture export/home sentinels too.
let exportNavUrl = null;
let homeNav = false;
await page2.route("https://wwwtopdf.export/**", (route) => {
  exportNavUrl = route.request().url();
  route.abort("aborted");
});
await page2.route("https://wwwtopdf.home/**", (route) => {
  homeNav = true;
  route.abort("aborted");
});
await page2.addScriptTag({ content: EDITOR });

// Native two-pane flow: Pane 1 (Edit) shows first with Next; format controls
// live in Pane 2 (hidden until Next).
check("native shows edit pane with 'Next: Format', format pane hidden", await page2.evaluate(() => {
  const edit = document.getElementById("wwwpdf-pane-edit");
  const fmt = document.getElementById("wwwpdf-pane-format");
  const hasNext = [...document.querySelectorAll("#wwwpdf-panel button")]
    .some((b) => b.textContent.includes("Next: Format"));
  return edit && fmt && hasNext &&
    getComputedStyle(edit).display !== "none" &&
    getComputedStyle(fmt).display === "none";
}));
check("edit pane has no sliders (those are in format pane)", await page2.evaluate(() => {
  const edit = document.getElementById("wwwpdf-pane-edit");
  return edit.querySelectorAll('input[type=range]').length === 0;
}));

// 11. Presets dropdown: "No Preset" first, then this-site preset starred.
check("dropdown has No Preset first, host preset starred", await page2.evaluate(() => {
  const opts = [...document.querySelectorAll("#wwwpdf-preset-sel option")];
  return (
    opts.length === 3 &&
    opts[0].value === "" &&
    opts[0].textContent === "No Preset" &&
    opts[1].textContent.startsWith("★") &&
    opts[1].textContent.includes("Kill nav+footer")
  );
}));

check("Update link hidden under No Preset", await page2.evaluate(() => {
  const link = [...document.querySelectorAll("#wwwpdf-panel a")]
    .find((a) => a.textContent.startsWith("Update "));
  return !link || getComputedStyle(link).display === "none";
}));

// Selecting a preset auto-applies it (change event).
check("selecting a preset auto-applies (no Apply button)", await page2.evaluate(() => {
  const hasApply = [...document.querySelectorAll("#wwwpdf-panel button")]
    .some((b) => b.textContent === "Apply");
  const sel = document.getElementById("wwwpdf-preset-sel");
  sel.value = "p1";
  sel.dispatchEvent(new Event("change"));
  return !hasApply &&
    document.getElementById("nav").classList.contains("wwwpdf-removed") &&
    document.getElementById("foot").classList.contains("wwwpdf-removed") &&
    document.getElementById("wwwpdf-count").textContent === "2 removed";
}));

// Editor is collapsed until the link is clicked.
check("preset editor hidden until 'Edit Presets' clicked", await page2.evaluate(() => {
  const box = document.getElementById("wwwpdf-preset-editor");
  const before = getComputedStyle(box).display;
  const link = [...document.querySelectorAll("#wwwpdf-panel a")]
    .find((a) => a.textContent === "Edit Presets");
  link.click();
  return before === "none" &&
    getComputedStyle(box).display !== "none" &&
    link.textContent === "Hide preset editor";
}));

check("preset removals undo", await page2.evaluate(() => {
  window.wwwToPdf.state.removeMode = false;
  [...document.querySelectorAll("#wwwpdf-panel button")]
    .find((b) => b.textContent === "Undo").click();
  return !document.getElementById("foot").classList.contains("wwwpdf-removed");
}));

// Update: a right-aligned "Update <name>" link tied to the selection.
check("Update link reads 'Update <preset name>'", await page2.evaluate(() =>
  [...document.querySelectorAll("#wwwpdf-panel a")]
    .some((a) => a.textContent === "Update Kill nav+footer" &&
      getComputedStyle(a).display !== "none")
));
await page2.evaluate(() => {
  presetNavUrl = null;
  [...document.querySelectorAll("#wwwpdf-panel a")]
    .find((a) => a.textContent.startsWith("Update ")).click();
});
await page2.waitForTimeout(200);
check("Update sends action=update with id + selectors", (() => {
  if (!presetNavUrl) return false;
  const u = new URL(presetNavUrl);
  const sels = JSON.parse(u.searchParams.get("sels") || "[]");
  return u.searchParams.get("action") === "update" &&
    u.searchParams.get("id") === "p1" &&
    sels.includes("#nav");
})());

// Save new: name input + recorded selectors.
await page2.evaluate(() => {
  presetNavUrl = null;
  document.querySelector("#wwwpdf-preset-editor input[type=text]").value = "My preset";
  [...document.querySelectorAll("#wwwpdf-panel button")]
    .find((b) => b.textContent === "Save new").click();
});
await page2.waitForTimeout(200);
check("Save new sends action=save with name + selectors", (() => {
  if (!presetNavUrl) return false;
  const u = new URL(presetNavUrl);
  const sels = JSON.parse(u.searchParams.get("sels") || "[]");
  return u.searchParams.get("action") === "save" &&
    u.searchParams.get("name") === "My preset" &&
    sels.includes("#nav");
})());

check("presetsUpdated refreshes the list, keeps No Preset", await page2.evaluate(() => {
  window.wwwToPdf.presetsUpdated([
    { id: "x", name: "Fresh", host: "a.example", selectors: ["p"] },
  ]);
  const opts = [...document.querySelectorAll("#wwwpdf-preset-sel option")];
  return opts.length === 2 && opts[0].textContent === "No Preset" &&
    opts[1].textContent.includes("Fresh");
}));

// 12. Progression: Next reveals the format pane with all controls.
check("Next reveals format pane; edit pane hidden", await page2.evaluate(() => {
  [...document.querySelectorAll("#wwwpdf-panel button")]
    .find((b) => b.textContent.includes("Next: Format")).click();
  const edit = document.getElementById("wwwpdf-pane-edit");
  const fmt = document.getElementById("wwwpdf-pane-format");
  return getComputedStyle(edit).display === "none" &&
    getComputedStyle(fmt).display !== "none" &&
    fmt.querySelectorAll("input[type=range]").length === 3 &&      // body/line/heading
    fmt.querySelectorAll("input[type=number]").length === 4;       // margins
}));
check("entering Format opens the inline preview overlay + sets previewMode", await page2.evaluate(() =>
  window.wwwToPdf.state.previewMode === true &&
  !!document.getElementById("wwwpdf-preview")
));

// 12b. Breadcrumb: Link · Edit · Format, each clickable to jump stages.
check("breadcrumb has Link / Edit / Format crumbs", await page2.evaluate(() => {
  const labels = [...document.querySelectorAll("#wwwpdf-panel a")].map((a) => a.textContent);
  return ["Link", "Edit", "Format"].every((l) => labels.includes(l));
}));
check("clicking 'Edit' crumb returns to edit pane and closes the preview overlay", await page2.evaluate(() => {
  [...document.querySelectorAll("#wwwpdf-panel a")].find((a) => a.textContent === "Edit").click();
  const edit = document.getElementById("wwwpdf-pane-edit");
  const fmt = document.getElementById("wwwpdf-pane-format");
  return getComputedStyle(edit).display !== "none" &&
    getComputedStyle(fmt).display === "none" &&
    window.wwwToPdf.state.previewMode === false &&
    !document.getElementById("wwwpdf-preview");
}));
check("clicking 'Format' crumb re-enters the format pane + reopens the overlay", await page2.evaluate(() => {
  [...document.querySelectorAll("#wwwpdf-panel a")].find((a) => a.textContent === "Format").click();
  return getComputedStyle(document.getElementById("wwwpdf-pane-format")).display !== "none" &&
    window.wwwToPdf.state.previewMode === true &&
    !!document.getElementById("wwwpdf-preview");
}));
check("format pane has header/footer + page-numbers", await page2.evaluate(() => {
  const fmt = document.getElementById("wwwpdf-pane-format");
  const texts = [...fmt.querySelectorAll("input[type=text]")];
  const checks = [...fmt.querySelectorAll("input[type=checkbox]")];
  return texts.length >= 2 && checks.length >= 3; // meta-toggle, guide, page-numbers
}));

// 13. Save/Preview fire the export sentinel with margins + header/footer/pagenum.
await page2.evaluate(() => {
  // set a margin, header text, page numbers via the format controls
  const fmt = document.getElementById("wwwpdf-pane-format");
  const right = fmt.querySelectorAll("input[type=number]")[1]; // top,right,bottom,left
  right.value = "1.5"; right.dispatchEvent(new Event("input"));
  const hdr = [...fmt.querySelectorAll("input[type=text]")]
    .find((i) => (i.placeholder || "").includes("article title"));
  hdr.value = "My Header"; hdr.dispatchEvent(new Event("input"));
});
await page2.evaluate(() => {
  [...document.querySelectorAll("#wwwpdf-panel button")]
    .find((b) => b.textContent === "Save PDF").click();
});
await page2.waitForTimeout(200);
check("Save fires export sentinel with action=save + params", (() => {
  if (!exportNavUrl) return false;
  const u = new URL(exportNavUrl);
  return u.hostname === "wwwtopdf.export" &&
    u.searchParams.get("action") === "save" &&
    u.searchParams.get("mr") === "1.5" &&
    u.searchParams.get("header") === "My Header";
})());
await page2.evaluate(() => {
  exportNavUrl = null;
  [...document.querySelectorAll("#wwwpdf-panel button")]
    .find((b) => b.textContent.includes("Refresh preview")).click();
});
await page2.waitForTimeout(200);
check("Refresh preview fires export sentinel with action=preview", (() => {
  if (!exportNavUrl) return false;
  return new URL(exportNavUrl).searchParams.get("action") === "preview";
})());

// 14. The "Link" breadcrumb fires the home sentinel (back to URL entry).
await page2.evaluate(() => {
  [...document.querySelectorAll("#wwwpdf-panel a")]
    .find((a) => a.textContent === "Link").click();
});
await page2.waitForTimeout(200);
check("'Link' breadcrumb fires home sentinel", homeNav);

// 15. The editor does not mount on our own app page (__WWWPDF_IS_APP).
const appPage = await browser.newPage();
await appPage.setContent(`<body></body>`, { waitUntil: "load" });
await appPage.evaluate(() => {
  window.__TAURI_INTERNALS__ = {};
  window.__WWWPDF_IS_APP = true;
});
await appPage.addScriptTag({ content: EDITOR });
check("editor suppressed on the app's own page", await appPage.evaluate(() =>
  !document.getElementById("wwwpdf-panel")
));
await appPage.close();

// 16. Inline PDF preview: the chunk protocol + pdf.js (the VENDORED build Rust
// injects) render the real PDF to <canvas> — even under a strict site CSP that
// forbids Web Workers (proving the main-thread fake-worker path). This is the
// half Rust drives via eval; here we drive it directly to prove the JS side.
{
  const PDF_LIB = readFileSync(new URL("../src-tauri/assets/pdf.min.js", import.meta.url), "utf8");
  const PDF_WORKER = readFileSync(new URL("../src-tauri/assets/pdf.worker.min.js", import.meta.url), "utf8");
  // A minimal valid 2-page PDF (built offline; "Page One" / "Page Two").
  const PDF_B64 =
    "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUiA1IDAgUl0gL0NvdW50IDIgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA3IDAgUiA+PiA+PiAvQ29udGVudHMgNCAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCAzOSA+PgpzdHJlYW0KQlQgL0YxIDI0IFRmIDcyIDcwMCBUZCAoUGFnZSBPbmUpIFRqIEVUCmVuZHN0cmVhbQplbmRvYmoKNSAwIG9iago8PCAvVHlwZSAvUGFnZSAvUGFyZW50IDIgMCBSIC9NZWRpYUJveCBbMCAwIDYxMiA3OTJdIC9SZXNvdXJjZXMgPDwgL0ZvbnQgPDwgL0YxIDcgMCBSID4+ID4+IC9Db250ZW50cyA2IDAgUiA+PgplbmRvYmoKNiAwIG9iago8PCAvTGVuZ3RoIDM5ID4+CnN0cmVhbQpCVCAvRjEgMjQgVGYgNzIgNzAwIFRkIChQYWdlIFR3bykgVGogRVQKZW5kc3RyZWFtCmVuZG9iago3IDAgb2JqCjw8IC9UeXBlIC9Gb250IC9TdWJ0eXBlIC9UeXBlMSAvQmFzZUZvbnQgL0hlbHZldGljYSA+PgplbmRvYmoKeHJlZgowIDgKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDEyMSAwMDAwMCBuIAowMDAwMDAwMjQ3IDAwMDAwIG4gCjAwMDAwMDAzMzYgMDAwMDAgbiAKMDAwMDAwMDQ2MiAwMDAwMCBuIAowMDAwMDAwNTUxIDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgOCAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKNjIxCiUlRU9G";

  const pvPage = await browser.newPage();
  // Serve a strict-CSP page (no workers, no blob scripts) to prove the
  // fake-worker path renders without a Web Worker.
  await pvPage.route("https://strict.example/", (route) => route.fulfill({
    status: 200, contentType: "text/html",
    headers: { "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:;" },
    body: "<!doctype html><html><body><h1>strict page</h1></body></html>",
  }));
  await pvPage.route("https://wwwtopdf.export/**", (route) => route.abort("aborted"));
  await pvPage.goto("https://strict.example/", { waitUntil: "load" });
  await pvPage.evaluate(() => { window.__TAURI_INTERNALS__ = {}; window.__WWWPDF_PRESETS = []; });
  await pvPage.addScriptTag({ content: EDITOR });
  // Enter Format -> opens the overlay (and fires a preview nav we abort).
  await pvPage.evaluate(() =>
    [...document.querySelectorAll("#wwwpdf-panel a")].find((a) => a.textContent === "Format").click()
  );
  check("overlay present after entering Format", await pvPage.evaluate(() =>
    !!document.getElementById("wwwpdf-preview")
  ));
  // Rust would inject these two scripts before streaming; do the same.
  await pvPage.addScriptTag({ content: PDF_LIB });
  await pvPage.addScriptTag({ content: PDF_WORKER });
  check("pdf.js UMD + worker load as classic scripts", await pvPage.evaluate(() =>
    typeof window.pdfjsLib === "object" && typeof window.pdfjsWorker === "object"
  ));
  // Drive the chunk protocol exactly as Rust does.
  await pvPage.evaluate((b64) => {
    window.wwwToPdf.__pvBegin();
    for (let i = 0; i < b64.length; i += 200) window.wwwToPdf.__pvChunk(b64.slice(i, i + 200));
    window.wwwToPdf.__pvEnd();
  }, PDF_B64);
  await pvPage.waitForFunction(
    () => document.querySelectorAll("#wwwpdf-preview canvas").length >= 2,
    { timeout: 8000 }
  ).catch(() => {});
  check("inline preview renders both PDF pages to canvas (no worker, strict CSP)",
    await pvPage.evaluate(() => document.querySelectorAll("#wwwpdf-preview canvas").length === 2)
  );
  check("rendered canvas actually has drawn content", await pvPage.evaluate(() => {
    const c = document.querySelector("#wwwpdf-preview canvas");
    if (!c) return false;
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let nonWhite = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 250 || d[i + 1] < 250 || d[i + 2] < 250) nonWhite++;
    return nonWhite > 20;
  }));
  await pvPage.close();
}

// 16b. Capture hides the preview overlay. The overlay (#wwwpdf-preview) is open,
// covering the page, when a Format-stage render fires; the capture-prep style
// (extracted from lib.rs) MUST hide it, or createPDF captures the overlay's
// flat grey instead of the page — the "grey boxes" bug. Regression guard.
{
  const librs = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  const prep = librs.match(/CAPTURE_PREP_JS: &str = r#"([\s\S]*?)"#;/);
  const done = librs.match(/CAPTURE_DONE_JS: &str =\s*"([\s\S]*?)";/);
  check("capture-prep + done scripts found in lib.rs", !!prep && !!done);
  if (prep && done) {
    const capPage = await browser.newPage();
    await capPage.route("https://wwwtopdf.export/**", (route) => route.abort("aborted"));
    await capPage.setContent(SAMPLE, { waitUntil: "load" });
    await capPage.evaluate(() => { window.__TAURI_INTERNALS__ = {}; window.__WWWPDF_PRESETS = []; });
    await capPage.addScriptTag({ content: EDITOR });
    // Enter Format -> opens the (grey) preview overlay over the page.
    await capPage.evaluate(() =>
      [...document.querySelectorAll("#wwwpdf-panel a")].find((a) => a.textContent === "Format").click()
    );
    check("overlay is visible before capture", await capPage.evaluate(() => {
      const ov = document.getElementById("wwwpdf-preview");
      return !!ov && getComputedStyle(ov).display !== "none";
    }));
    // Run the exact capture-prep the native renderer runs before createPDF.
    await capPage.evaluate((js) => window.eval(js), prep[1]);
    check("capture-prep hides the preview overlay (no grey-box capture)", await capPage.evaluate(() =>
      getComputedStyle(document.getElementById("wwwpdf-preview")).display === "none"
    ));
    check("capture-prep hides panel + toast but not the metadata header", await capPage.evaluate(() => {
      const panelHidden = getComputedStyle(document.getElementById("wwwpdf-panel")).display === "none";
      const cap = document.getElementById("wwwpdf-capture");
      // The capture style must not target the metadata header (it belongs in the PDF).
      const keepsMeta = !!cap && !/wwwpdf-meta/.test(cap.textContent);
      return panelHidden && keepsMeta;
    }));
    // Capture-done restores the overlay so the render can draw into it.
    await capPage.evaluate((js) => window.eval(js), done[1]);
    check("capture-done restores the overlay", await capPage.evaluate(() =>
      getComputedStyle(document.getElementById("wwwpdf-preview")).display !== "none"
    ));
    await capPage.close();
  }
}

// 17. Phone form factor: the toolbar docks as a full-width bottom sheet so the
// preview stays visible above it (rather than a floating card that covers it).
{
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await phone.route("https://wwwtopdf.export/**", (route) => route.abort("aborted"));
  await phone.setContent(SAMPLE, { waitUntil: "load" });
  await phone.evaluate(() => { window.__TAURI_INTERNALS__ = {}; window.__WWWPDF_PRESETS = []; });
  await phone.addScriptTag({ content: EDITOR });
  check("panel docks full-width to the bottom on a phone viewport", await phone.evaluate(() => {
    const el = document.getElementById("wwwpdf-panel");
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return cs.position === "fixed" &&
      Math.round(r.left) === 0 &&
      Math.round(r.right) === window.innerWidth &&
      Math.round(r.bottom) === window.innerHeight;
  }));
  // Enter Format: the preview must occupy the space above the sheet, not be
  // eclipsed by it.
  await phone.evaluate(() =>
    [...document.querySelectorAll("#wwwpdf-panel a")].find((a) => a.textContent === "Format").click()
  );
  check("preview overlay stays visible above the docked sheet", await phone.evaluate(() => {
    const panel = document.getElementById("wwwpdf-panel").getBoundingClientRect();
    const ov = document.getElementById("wwwpdf-preview");
    // Sheet leaves a meaningful strip of the viewport for the preview.
    return !!ov && panel.top > window.innerHeight * 0.3;
  }));
  await phone.close();
}

// 18. On a wide (desktop/tablet) viewport the panel stays a floating card, not
// docked — the bottom-sheet rules are phone-only.
{
  const wide = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await wide.setContent(SAMPLE, { waitUntil: "load" });
  await wide.evaluate(() => { window.__TAURI_INTERNALS__ = {}; window.__WWWPDF_PRESETS = []; });
  await wide.addScriptTag({ content: EDITOR });
  check("panel is a floating top-right card on a wide viewport", await wide.evaluate(() => {
    const r = document.getElementById("wwwpdf-panel").getBoundingClientRect();
    return Math.round(r.left) > 0 && Math.round(r.right) < window.innerWidth &&
      Math.round(r.top) < 100 && Math.round(r.width) < 400;
  }));
  await wide.close();
}

// 19. Removal enforcement: removals survive the page's own JS. Ad-heavy sites
// resurrect "removed" elements two ways — rewriting className (wiping our
// class) and replacing the node wholesale (fresh element, no class). Both
// must be re-asserted before the next paint.
{
  const p = await browser.newPage();
  await p.setContent(SAMPLE, { waitUntil: "load" });
  await p.addScriptTag({ content: EDITOR });
  await p.evaluate(() => { window.wwwToPdf.state.removeMode = true; });
  await p.click("#nav");
  await p.evaluate(() => { window.wwwToPdf.state.removeMode = false; });
  // (a) the site wipes the class attribute
  await p.evaluate(() => { document.getElementById("nav").className = "site-nav"; });
  check("enforcement: class wipe is re-asserted", await p.evaluate(() => {
    const nav = document.getElementById("nav");
    return nav.classList.contains("wwwpdf-removed") &&
      getComputedStyle(nav).display === "none";
  }));
  // (b) the site replaces the node wholesale (framework re-render / ad refresh)
  await p.evaluate(() => {
    const old = document.getElementById("nav");
    const fresh = document.createElement("nav");
    fresh.id = "nav";
    fresh.textContent = "RESURRECTED AD";
    old.replaceWith(fresh);
  });
  check("enforcement: replaced node is re-removed via its selector", await p.evaluate(() => {
    const nav = document.getElementById("nav");
    return getComputedStyle(nav).display === "none" &&
      document.getElementById("wwwpdf-count").textContent === "1 removed";
  }));
  // (c) the site tears out our style element
  await p.evaluate(() => { document.getElementById("wwwpdf-style").remove(); });
  await p.evaluate(() => {
    document.body.appendChild(document.createElement("div")); // any mutation
  });
  check("enforcement: style element is re-created if the page removes it", await p.evaluate(() =>
    !!document.getElementById("wwwpdf-style") &&
    getComputedStyle(document.getElementById("nav")).display === "none"
  ));
  // (d) undo is intentional un-hiding — the enforcer must NOT fight it
  await p.evaluate(() => {
    [...document.querySelectorAll("#wwwpdf-panel button")]
      .find((b) => b.textContent === "Undo").click();
  });
  await p.evaluate(() => {
    document.body.appendChild(document.createElement("div")); // any mutation
  });
  check("enforcement: undo sticks (no re-remove after undo)", await p.evaluate(() =>
    getComputedStyle(document.getElementById("nav")).display !== "none"
  ));
  await p.close();
}

// 20. Capture freeze: no page JS may run between removing elements and the
// PDF capture. Hidden elements are physically DETACHED (a node outside the
// DOM can't be resurrected by any style trick), pending timers are cancelled,
// new scheduling is inert, and anything that still mutates the DOM is caught
// by the enforcement observer. Thaw re-attaches and restores the real APIs.
{
  const p = await browser.newPage();
  await p.setContent(SAMPLE, { waitUntil: "load" });
  await p.addScriptTag({ content: EDITOR });
  await p.evaluate(() => { window.wwwToPdf.state.removeMode = true; });
  await p.click("#nav");
  await p.evaluate(() => { window.wwwToPdf.state.removeMode = false; });
  await p.evaluate(() => {
    // An "ad script" already scheduled before the freeze…
    window.__reinjected = false;
    setTimeout(() => { window.__reinjected = true; }, 100);
    window.wwwToPdf.__captureFreeze();
  });
  check("freeze physically detaches removed elements (same-tag placeholder)",
    await p.evaluate(() =>
      document.getElementById("nav") === null &&
      !!document.querySelector("nav[data-wwwpdf-hole]") &&
      getComputedStyle(document.querySelector("nav[data-wwwpdf-hole]")).display === "none"
    ));
  await p.waitForTimeout(300);
  check("freeze cancels timers the page had pending", await p.evaluate(() =>
    window.__reinjected === false
  ));
  check("freeze makes new setTimeout/rAF inert", await p.evaluate(() => {
    window.__late = false;
    const id = setTimeout(() => { window.__late = true; }, 0);
    requestAnimationFrame(() => { window.__late = true; });
    return id >= 1000000000;
  }));
  await p.waitForTimeout(150);
  check("…and their callbacks never fire", await p.evaluate(() => window.__late === false));
  // DOM mutation during the freeze (e.g. a fetch handler already in flight
  // injecting a NEW container that matches a removed selector) is still
  // corrected by the enforcement observer before any paint.
  await p.evaluate(() => {
    const fresh = document.createElement("nav");
    fresh.id = "nav";
    fresh.textContent = "MID-CAPTURE AD";
    document.body.appendChild(fresh);
  });
  check("new nodes matching a removed selector are hidden mid-capture", await p.evaluate(() =>
    getComputedStyle(document.getElementById("nav")).display === "none"
  ));
  await p.evaluate(() => { window.wwwToPdf.__captureThaw(); });
  check("thaw re-attaches the original (still removed) and drops placeholders",
    await p.evaluate(() => {
      const navs = document.querySelectorAll("nav#nav");
      return !document.querySelector("[data-wwwpdf-hole]") &&
        navs.length === 2 && // the original is back; the mid-capture one stays
        [...navs].every((n) => getComputedStyle(n).display === "none");
    }));
  await p.evaluate(() => {
    window.__thawed = false;
    setTimeout(() => { window.__thawed = true; }, 10);
  });
  await p.waitForTimeout(120);
  check("thaw restores real timers", await p.evaluate(() => window.__thawed === true));
  await p.close();
}

// 20c. The detach must not disturb the styling of KEPT content: display:none
// elements still count for :nth-child, so placeholders have to keep sibling
// positions (same tag, same slot) or zebra tables / sibling margins would
// shift in the PDF relative to the edit view. Also: hiding must win the CSS
// war on screen — anti-adblock rules like #id{display:block!important}
// outrank a class rule, but not an important inline declaration.
{
  const p = await browser.newPage();
  await p.setContent(`<!doctype html><html><head><style>
      li { color: rgb(0, 0, 0); }
      li:nth-child(3) { color: rgb(200, 0, 50); }
      #zap { display: block !important; } /* anti-adblock: outranks any class rule */
    </style></head><body>
      <ul><li id="l1">one</li><li id="zap">AD</li><li id="l3">three</li></ul>
    </body></html>`, { waitUntil: "load" });
  await p.addScriptTag({ content: EDITOR });
  await p.evaluate(() => { window.wwwToPdf.state.removeMode = true; });
  await p.click("#zap");
  await p.evaluate(() => { window.wwwToPdf.state.removeMode = false; });
  check("removal beats a display:block!important id rule (inline important)",
    await p.evaluate(() =>
      getComputedStyle(document.getElementById("zap")).display === "none"
    ));
  await p.evaluate(() => window.wwwToPdf.__captureFreeze());
  check("during capture, kept content keeps its :nth-child styling",
    await p.evaluate(() =>
      document.getElementById("zap") === null &&
      getComputedStyle(document.getElementById("l3")).color === "rgb(200, 0, 50)"
    ));
  await p.evaluate(() => window.wwwToPdf.__captureThaw());
  check("thaw restores the node; Undo restores its inline style exactly",
    await p.evaluate(() => {
      const zap = document.getElementById("zap");
      const hiddenBack = !!zap && getComputedStyle(zap).display === "none";
      [...document.querySelectorAll("#wwwpdf-panel button")]
        .find((b) => b.textContent === "Undo").click();
      return hiddenBack && getComputedStyle(zap).display !== "none" &&
        !zap.getAttribute("style");
    }));
  await p.close();
}

// 20b. The native capture scripts drive the freeze: prep freezes before
// createPDF, done thaws after (extracted from lib.rs, run for real).
{
  const librs = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  const prep = librs.match(/CAPTURE_PREP_JS: &str = r#"([\s\S]*?)"#;/);
  const done = librs.match(/CAPTURE_DONE_JS: &str =\s*"([\s\S]*?)";/);
  check("capture-prep freezes page JS, capture-done thaws",
    !!prep && !!done &&
    prep[1].includes("__captureFreeze") && done[1].includes("__captureThaw"));
  if (prep && done) {
    const p = await browser.newPage();
    await p.setContent(SAMPLE, { waitUntil: "load" });
    await p.addScriptTag({ content: EDITOR });
    await p.evaluate((js) => window.eval(js), prep[1]);
    check("running capture-prep engages the freeze", await p.evaluate(() => {
      const id = setTimeout(() => {}, 0);
      return id >= 1000000000;
    }));
    await p.evaluate((js) => window.eval(js), done[1]);
    check("running capture-done releases the freeze", await p.evaluate(() => {
      const id = setTimeout(() => {}, 0);
      return id < 1000000000;
    }));
    await p.close();
  }
}

// 21. Bushido ad blocking, web/fallback path: the built-in selector list hides
// unambiguous ad containers on mount; the toggle works; a selector set pushed
// by the native engine replaces the fallback.
const AD_SAMPLE = `<!doctype html><html><head><title>Ads</title></head><body>
  <h1>Article</h1>
  <p id="content">Real content stays.</p>
  <div class="adsbygoogle" id="ad1">AD 1</div>
  <div id="div-gpt-ad-123-0" >AD 2</div>
  <div class="ad-banner" id="ad3">AD 3</div>
  <div id="custom-ad">engine-flagged ad</div>
</body></html>`;
{
  const p = await browser.newPage();
  await p.setContent(AD_SAMPLE, { waitUntil: "load" });
  await p.addScriptTag({ content: EDITOR });
  const hidden = (id) => p.evaluate(
    (i) => getComputedStyle(document.getElementById(i)).display === "none", id);
  check("built-in filters hide ad containers on mount",
    (await hidden("ad1")) && (await hidden("div-gpt-ad-123-0")) && (await hidden("ad3")));
  check("…but not the content (or unknown ids)",
    !(await hidden("content")) && !(await hidden("custom-ad")));
  check("Block ads checkbox is on; status names the built-in list", await p.evaluate(() => {
    const status = document.getElementById("wwwpdf-adcount");
    const cb = status && [...document.querySelectorAll("#wwwpdf-panel label")]
      .find((l) => l.textContent.includes("Block ads"))?.querySelector("input");
    return !!cb && cb.checked && /built-in/.test(status.textContent) &&
      /3 hidden/.test(status.textContent);
  }));
  // An ad injected AFTER the filters applied is dead on arrival (CSS rule).
  await p.evaluate(() => {
    const late = document.createElement("div");
    late.className = "adsbygoogle";
    late.id = "late-ad";
    document.body.appendChild(late);
  });
  check("late-injected ad is hidden on arrival", await hidden("late-ad"));
  // Toggle off -> ads return; engine pushes respect the explicit opt-out.
  const toggle = () => p.evaluate(() => {
    [...document.querySelectorAll("#wwwpdf-panel label")]
      .find((l) => l.textContent.includes("Block ads")).querySelector("input").click();
  });
  await toggle();
  check("toggle off restores the ad containers", !(await hidden("ad1")));
  await p.evaluate(() => window.wwwToPdf.setAdblockSelectors(["#custom-ad", "bad[[selector"]));
  check("engine push while opted out stays off", !(await hidden("custom-ad")));
  await toggle();
  check("toggle back on applies the ENGINE set (replaces built-ins, skips bad selectors)",
    (await hidden("custom-ad")) && !(await hidden("ad1")) && await p.evaluate(() =>
      /EasyList/.test(document.getElementById("wwwpdf-adcount").textContent)));
  // Ad-blocked elements are detached for the capture too, and come back.
  await p.evaluate(() => window.wwwToPdf.__captureFreeze());
  check("capture detaches ad-blocked elements as well", await p.evaluate(() =>
    document.getElementById("custom-ad") === null &&
    !!document.querySelector("div[data-wwwpdf-hole]")
  ));
  await p.evaluate(() => window.wwwToPdf.__captureThaw());
  check("thaw restores ad-blocked elements (still hidden)", await p.evaluate(() => {
    const ad = document.getElementById("custom-ad");
    return !!ad && getComputedStyle(ad).display === "none" &&
      !document.querySelector("[data-wwwpdf-hole]");
  }));
  await p.close();
}

// 21b. Web export: window.print() snapshots the DOM, so the hidden elements
// must be physically absent while the dialog is open and back afterwards.
{
  const p = await browser.newPage();
  await p.setContent(SAMPLE, { waitUntil: "load" });
  await p.addScriptTag({ content: EDITOR });
  await p.evaluate(() => { window.wwwToPdf.state.removeMode = true; });
  await p.click("#nav");
  await p.evaluate(() => {
    window.wwwToPdf.state.removeMode = false;
    window.print = () => {
      window.__printSawDetached = document.getElementById("nav") === null &&
        !!document.querySelector("nav[data-wwwpdf-hole]");
    };
  });
  await p.evaluate(() => {
    [...document.querySelectorAll("#wwwpdf-panel button")]
      .find((b) => b.textContent === "Save as PDF").click();
  });
  check("print dialog sees removed elements physically detached", await p.evaluate(() =>
    window.__printSawDetached === true
  ));
  check("after print they are re-attached (and still removed)", await p.evaluate(() => {
    const nav = document.getElementById("nav");
    return !!nav && getComputedStyle(nav).display === "none" &&
      !document.querySelector("[data-wwwpdf-hole]");
  }));
  await p.close();
}

// 22. Bushido ad blocking, native path: Rust may stash the engine's selector
// set before the editor mounts; the Edit pane hosts the controls; "Refresh
// filters" asks Rust to recompute via the wwwtopdf.adblock sentinel.
{
  const p = await browser.newPage();
  let adblockNavUrl = null;
  await p.route("https://wwwtopdf.adblock/**", (route) => {
    adblockNavUrl = route.request().url();
    route.abort("aborted");
  });
  await p.route("https://wwwtopdf.export/**", (route) => route.abort("aborted"));
  await p.setContent(AD_SAMPLE, { waitUntil: "load" });
  await p.evaluate(() => {
    window.__TAURI_INTERNALS__ = {};
    window.__WWWPDF_PRESETS = [];
    window.__WWWPDF_ADBLOCK = ["#custom-ad"]; // pushed by Rust pre-mount
  });
  await p.addScriptTag({ content: EDITOR });
  check("pre-mount engine push wins over the built-in list", await p.evaluate(() =>
    getComputedStyle(document.getElementById("custom-ad")).display === "none" &&
    getComputedStyle(document.getElementById("ad1")).display !== "none" &&
    /EasyList/.test(document.getElementById("wwwpdf-adcount").textContent)
  ));
  check("ad-block controls live in the Edit pane", await p.evaluate(() =>
    !!document.getElementById("wwwpdf-pane-edit")
      .querySelector("#wwwpdf-adcount")
  ));
  await p.evaluate(() => {
    [...document.querySelectorAll("#wwwpdf-panel a")]
      .find((a) => a.textContent.includes("Refresh filters")).click();
  });
  await p.waitForTimeout(200);
  check("Refresh filters fires the wwwtopdf.adblock sentinel", (() => {
    if (!adblockNavUrl) return false;
    const u = new URL(adblockNavUrl);
    return u.hostname === "wwwtopdf.adblock" && u.searchParams.get("action") === "refresh";
  })());
  // A later engine push (Rust re-harvest) replaces the set live.
  await p.evaluate(() => window.wwwToPdf.setAdblockSelectors(["#custom-ad", ".adsbygoogle"]));
  check("post-mount engine push updates hiding live", await p.evaluate(() =>
    getComputedStyle(document.getElementById("ad1")).display === "none"
  ));
  await p.close();
}

// 23. Metadata title: as a native init script the editor evaluates at
// document-start, BEFORE <title> is parsed — the title must be filled in at
// mount time, not at parse time.
{
  const p = await browser.newPage();
  await p.addInitScript({ content: EDITOR }); // document-start, like Tauri
  // A real navigation (not setContent, which document.write()s and skips
  // init scripts) so the editor genuinely evaluates before <title> parses.
  await p.route("https://init.example/", (route) => route.fulfill({
    status: 200, contentType: "text/html", body: SAMPLE,
  }));
  await p.goto("https://init.example/", { waitUntil: "load" });
  await p.waitForSelector("#wwwpdf-panel");
  check("meta title fills from <title> when injected at document-start", await p.evaluate(() =>
    window.wwwToPdf.state.meta.title === "Sample Article"
  ));
  check("…and the Title field shows it", await p.evaluate(() =>
    document.querySelector("#wwwpdf-metafields input").value === "Sample Article"
  ));
  await p.close();
}

// 24. Stacking: the metadata header carries a huge z-index so host CSS can't
// bury it — but the Format-stage preview overlay must still cover it (the
// "fixed header floating above the preview" bug), while panel + toast stay
// above the overlay.
{
  const p = await browser.newPage();
  await p.route("https://wwwtopdf.export/**", (route) => route.abort("aborted"));
  await p.setContent(SAMPLE, { waitUntil: "load" });
  await p.evaluate(() => { window.__TAURI_INTERNALS__ = {}; window.__WWWPDF_PRESETS = []; });
  await p.addScriptTag({ content: EDITOR });
  await p.evaluate(() =>
    [...document.querySelectorAll("#wwwpdf-panel a")].find((a) => a.textContent === "Format").click()
  );
  check("preview overlay stacks above the metadata header, below the panel",
    await p.evaluate(() => {
      const z = (id) => parseInt(getComputedStyle(document.getElementById(id)).zIndex, 10);
      return z("wwwpdf-preview") > z("wwwpdf-meta") && z("wwwpdf-panel") > z("wwwpdf-preview");
    }));
  await p.close();
}

// 25. Settle loop (extracted VERBATIM from lib.rs): lazy-loading articles
// materialize content only when it approaches the viewport, so a single
// early height measurement truncates the PDF. Driving the settle probe the
// way the native loop does (measure -> grow the frame -> repeat) must pull in
// the whole article and then detect stability.
{
  const librs = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  const m = librs.match(/SETTLE_JS: &str = r#"([\s\S]*?)"#;/);
  check("settle script found in lib.rs", !!m);
  if (m) {
    const p = await browser.newPage({ viewport: { width: 700, height: 600 } });
    await p.setContent(`<!doctype html><html><body>
      <div id="art"></div>
      <script>
        // Simulated lazy article, the common shape: N independent placeholders
        // present from the start, each hydrating to a 500px section when it
        // enters the viewport (IntersectionObserver). Growing the frame to the
        // content height brings the below-the-fold placeholders into view, so
        // they fill in — exactly what the native settle loop provokes.
        const art = document.getElementById("art");
        const io = new IntersectionObserver((es) => {
          es.forEach((e) => {
            if (e.isIntersecting && !e.target.dataset.filled) {
              e.target.dataset.filled = "1";
              e.target.className = "chunk";
              e.target.style.height = "500px";
            }
          });
        });
        // Placeholders 120px tall so 13 of them (1560px) exceed the 600px
        // viewport — the below-fold ones only hydrate once the frame grows.
        for (let i = 0; i < 13; i++) {
          const ph = document.createElement("div");
          ph.style.height = "120px";
          art.appendChild(ph);
          io.observe(ph);
        }
      <\/script>
    </body></html>`, { waitUntil: "load" });
    let lastH = 0;
    let stable = 0;
    let iters = 0;
    for (; iters < 14; iters++) {
      const r = JSON.parse(await p.evaluate(m[1]));
      if (Math.abs(r.h - lastH) <= 2 && r.p === 0) {
        if (++stable >= 2) break;
      } else {
        stable = 0;
      }
      if (r.h > lastH) {
        await p.setViewportSize({ width: 700, height: Math.min(Math.ceil(r.h) + 8, 20000) });
      }
      lastH = r.h;
      await p.waitForTimeout(80);
    }
    const chunkCount = await p.evaluate(() => document.querySelectorAll(".chunk").length);
    check(`settle loop materializes the whole lazy article (${chunkCount} chunks, h=${lastH})`,
      chunkCount >= 13 && lastH >= 13 * 500);
    check("settle loop detects stability and terminates", iters < 14);
    await p.close();
  }
}

await browser.close();

let ok = true;
for (const [name, pass] of results) {
  console.log(`${pass ? "✓" : "✗"} ${name}`);
  if (!pass) ok = false;
}
process.exit(ok ? 0 : 1);
