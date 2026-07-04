import { chromium } from "playwright";
const b = await chromium.launch({ executablePath: process.env.PW_CHROME, args:["--no-sandbox"] });
const p = await b.newPage({ viewport: { width: 1150, height: 780 } });
await p.goto("http://localhost:4173/");
await p.evaluate(() => {
  localStorage.setItem("wwwpdf:history", JSON.stringify([
    "https://example.substack.com/p/some-article",
    "https://en.wikipedia.org/wiki/Portable_Document_Format",
  ]));
});
await p.reload();
await p.screenshot({ path: process.env.DIR + "/stage1.png" });
await p.evaluate(() => {
  document.getElementById("entry").hidden = true;
  document.getElementById("pdf-settings").hidden = false;
  document.getElementById("pv-meta-on").checked = true;
  document.getElementById("pv-meta-fields").hidden = false;
});
await p.screenshot({ path: process.env.DIR + "/stage3.png" });
await b.close();
console.log("shots done");
