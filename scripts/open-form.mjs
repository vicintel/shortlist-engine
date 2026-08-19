import { chromium } from "playwright";
const url = process.argv[2];
const b = await chromium.launch({ headless: false, slowMo: 50 });
const p = await b.newPage({ viewport: { width: 1440, height: 1050 } });
await p.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
await p.waitForTimeout(3500);
await p.getByRole("button", { name: /^apply$/i }).first().click().catch(() => {});
await p.waitForTimeout(4000);

const fields = await p.evaluate(() =>
  [...document.querySelectorAll("input,textarea")]
    .filter(el => el.offsetParent !== null && el.type !== "hidden" && !/search this page/i.test(el.placeholder || ""))
    .map(el => ({
      tag: el.tagName.toLowerCase(), type: el.type || "",
      req: el.required || el.getAttribute("aria-required") === "true",
      q: (el.labels?.[0]?.innerText || el.getAttribute("aria-label") || el.placeholder || "").replace(/\s+/g, " ").slice(0, 200),
    })));
console.log("\nFORM FIELDS\n");
fields.forEach(f => console.log(`${f.req ? "*" : " "} ${f.tag}/${f.type}  ${f.q}`));
console.log("\nBrowser open. Nothing filled, nothing sent.\n");
await p.waitForTimeout(900000);
