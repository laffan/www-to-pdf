import { chromium } from "playwright";
const b = await chromium.launch({ executablePath: process.env.PW_CHROME, args:["--no-sandbox"] });
const p = await b.newPage({ viewport: { width: 900, height: 620 } });
p.on("pageerror", e => console.log("[pageerror]", e.message));
await p.goto("http://localhost:4173/");
await p.evaluate(() => localStorage.setItem("wwwpdf:history", JSON.stringify([
  { u: "https://example.substack.com/p/the-long-article-title-here", t: "The Long Article Title Here — Newsletter" },
  "https://en.wikipedia.org/wiki/Portable_Document_Format",
])));
await p.reload();
await p.waitForTimeout(200);
// exercise setHistoryTitle backfill
await p.evaluate(() => window.__wwwpdfSetHistoryTitle(
  "https://en.wikipedia.org/wiki/Portable_Document_Format", "Portable Document Format - Wikipedia"));
const r = await p.evaluate(() => ({
  count: document.querySelectorAll("#history li").length,
  firstTitle: document.querySelector("#history .h-title")?.textContent,
  bothTitled: document.querySelectorAll("#history .h-title").length,
}));
console.log(JSON.stringify(r));
await p.screenshot({ path: process.env.DIR + "/hist.png" });
await b.close();
