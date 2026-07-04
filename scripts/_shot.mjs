import { chromium } from "playwright";
const b = await chromium.launch({ executablePath: process.env.PW_CHROME, args:["--no-sandbox"] });
const p = await b.newPage({ viewport: { width: 1024, height: 700 } });
await p.goto("http://localhost:4173/");
const state = await p.evaluate(() => {
  const f = document.querySelector(".url-form");
  const r = f.getBoundingClientRect();
  return {
    onlyChildren: [...document.getElementById("entry").children].map(e => e.tagName + (e.hidden ? "(hidden)" : "")),
    horizCentered: Math.abs((r.left + r.width / 2) - window.innerWidth / 2) < 2,
    vertCentered: Math.abs((r.top + r.height / 2) - window.innerHeight / 2) < 40,
  };
});
console.log(JSON.stringify(state));
await p.screenshot({ path: process.env.SHOT || "entry.png" });
await b.close();
