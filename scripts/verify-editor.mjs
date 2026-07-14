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

// 7. applySettings drives fonts + metadata (the stage-3 preview window path)
await page.evaluate(() =>
  window.wwwToPdf.applySettings({
    bodyPx: 18,
    headingScale: 1.5,
    margins: { top: 0.75 },
    meta: { show: true, author: "Test Author" },
  })
);
check("applySettings sets body font", await page.evaluate(() =>
  Math.round(parseFloat(getComputedStyle(document.getElementById("para")).fontSize)) === 18
));
await page.evaluate(() => window.wwwToPdf.applySettings({ lineHeight: 2.0 }));
check("applySettings sets line height", await page.evaluate(() => {
  const p = document.getElementById("para");
  const lh = parseFloat(getComputedStyle(p).lineHeight);
  const fs = parseFloat(getComputedStyle(p).fontSize);
  return Math.abs(lh / fs - 2.0) < 0.05;
}));
check("applySettings updates @page margins", await page.evaluate(() =>
  document.getElementById("wwwpdf-style").textContent.includes("margin:0.75in")
));
check("applySettings updates metadata", await page.evaluate(() =>
  document.getElementById("wwwpdf-meta").textContent.includes("Test Author")
));

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
await page2.addScriptTag({ content: EDITOR });
check("tauri panel has Next button", await page2.evaluate(() =>
  [...document.querySelectorAll("#wwwpdf-panel button")].some((b) =>
    b.textContent.includes("PDF settings")
  )
));
check("tauri panel has no sliders/save", await page2.evaluate(() =>
  document.querySelectorAll("#wwwpdf-panel input[type=range]").length === 0 &&
  ![...document.querySelectorAll("#wwwpdf-panel button")].some((b) =>
    b.textContent.includes("Save as PDF")
  )
));

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

await browser.close();

let ok = true;
for (const [name, pass] of results) {
  console.log(`${pass ? "✓" : "✗"} ${name}`);
  if (!pass) ok = false;
}
process.exit(ok ? 0 : 1);
