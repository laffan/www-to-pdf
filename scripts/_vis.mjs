import { chromium } from "playwright";
const b = await chromium.launch({ executablePath: process.env.PW_CHROME, args:["--no-sandbox"] });
const p = await b.newPage();
await p.goto("http://localhost:4173/");
const r = await p.evaluate(() => {
  const g = id => { const e=document.getElementById(id); return e? getComputedStyle(e).display : "MISSING"; };
  return { entry:g("entry"), viewer:g("viewer"), blocked:g("blocked"), entryVisible: !!document.getElementById("url-input")?.offsetParent };
});
console.log(JSON.stringify(r));
await b.close();
