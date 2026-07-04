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

// 5. unmount removes the panel
await page.evaluate(() => window.wwwToPdf.unmount());
check("unmount removes panel", await page.evaluate(() => !document.getElementById("wwwpdf-panel")));

await browser.close();

let ok = true;
for (const [name, pass] of results) {
  console.log(`${pass ? "✓" : "✗"} ${name}`);
  if (!pass) ok = false;
}
process.exit(ok ? 0 : 1);
