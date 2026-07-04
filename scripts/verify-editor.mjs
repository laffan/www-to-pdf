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
check("applySettings updates @page margins", await page.evaluate(() =>
  document.getElementById("wwwpdf-style").textContent.includes("margin:0.75in")
));
check("applySettings updates metadata", await page.evaluate(() =>
  document.getElementById("wwwpdf-meta").textContent.includes("Test Author")
));

// 8. unmount removes the panel
await page.evaluate(() => window.wwwToPdf.unmount());
check("unmount removes panel", await page.evaluate(() => !document.getElementById("wwwpdf-panel")));

// 9. Tauri mode: stage-2 panel is remove-tools + Next only
const page2 = await browser.newPage();
await page2.setContent(SAMPLE, { waitUntil: "load" });
await page2.evaluate(() => { window.__TAURI_INTERNALS__ = {}; });
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

await browser.close();

let ok = true;
for (const [name, pass] of results) {
  console.log(`${pass ? "✓" : "✗"} ${name}`);
  if (!pass) ok = false;
}
process.exit(ok ? 0 : 1);
