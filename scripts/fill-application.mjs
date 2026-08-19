#!/usr/bin/env node
/**
 * Opens an application form in a real browser and fills what it can from the kit.
 *
 *   node scripts/fill-application.mjs <jobId> [--submit-nothing]
 *
 * It never submits. It fills, then reads every field back and reports what actually
 * landed, because on the Ashby fills of 12 August a different required field failed
 * silently each time — get_by_label matched, the value never stuck, and the form
 * looked complete. Reporting what is verifiably in the field is the whole point.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const CV = "/Users/mac/Downloads/Victor Dickson — CV.pdf";
const ME = {
  first: "Victor", last: "Dickson", full: "Victor Dickson",
  email: "victordickson1998@gmail.com",
  phone: "+2348140652157",
  location: "Lagos, Nigeria",
  linkedin: "https://linkedin.com/in/victor-dickson-0b7650122",
  github: "https://github.com/vicintel",
  portfolio: "https://myportfolio-one-eta-18.vercel.app",
};

const jobId = process.argv[2];
if (!jobId) { console.log("usage: fill-application.mjs <jobId>"); process.exit(1); }

const db = JSON.parse(fs.readFileSync("data/jobs.json", "utf8"));
const job = db.jobs[jobId] || Object.values(db.jobs).find((j) => j.id.startsWith(jobId));
if (!job) { console.log(`no job ${jobId}`); process.exit(1); }

const dir = "data/applications";
const kitFile = fs.readdirSync(dir).find((f) => f.includes(job.id.slice(0, 8)));
if (!kitFile) { console.log("no kit for this job — run `apply` first"); process.exit(1); }
const kit = fs.readFileSync(path.join(dir, kitFile), "utf8");
const section = (n) => (kit.split(`## ${n}`)[1] || "").split(/\n---/)[0].trim();
const coverLetter = section("Cover letter");

console.log(`\n  ${job.title} — ${job.company}`);
console.log(`  ${job.url}\n`);

const browser = await chromium.launch({ headless: false, slowMo: 60 });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(2500);

// Ashby renders the form only after the Apply button is clicked.
for (const name of [/^apply for this job$/i, /^apply now$/i, /^apply$/i]) {
  const btn = page.getByRole("button", { name }).first();
  if (await btn.count().catch(() => 0)) { await btn.click().catch(() => {}); await page.waitForTimeout(2500); break; }
}

for (const label of ["Apply for this job", "Apply Now", "Apply"]) {
  const btn = page.getByRole("button", { name: new RegExp(`^${label}$`, "i") }).first();
  if (await btn.count().catch(() => 0)) { await btn.click().catch(() => {}); await page.waitForTimeout(2500); break; }
}

const filled = [];
const failed = [];

/** Fill, then read back. A locator that matched is not a value that stuck. */
async function set(label, patterns, value, { type = "fill" } = {}) {
  for (const p of patterns) {
    const el = page.locator(p).first();
    try {
      if (!(await el.count()) || !(await el.isVisible())) continue;
      if (type === "file") { await el.setInputFiles(value); filled.push([label, path.basename(value)]); return true; }
      await el.scrollIntoViewIfNeeded();
      await el.fill(value, { timeout: 5000 });
      const got = await el.inputValue().catch(() => "");
      // Compare on digits/letters only: phone and date fields reformat as you type,
      // and a reformatted value is a success, not a failure.
      const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, "");
      if (norm(got).includes(norm(value).slice(0, 10))) { filled.push([label, got.slice(0, 48)]); return true; }
      failed.push([label, `typed but field reads "${got.slice(0, 30)}"`]);
      return false;
    } catch { /* try the next selector */ }
  }
  failed.push([label, "no matching field found"]);
  return false;
}

await set("First name", ['input[name*="first" i]', 'input[id*="first" i]', 'input[aria-label*="First" i]'], ME.first);
await set("Last name",  ['input[name*="last" i]', 'input[id*="last" i]', 'input[aria-label*="Last" i]'], ME.last);
await set("Full name",  ['input[name="_systemfield_name"]', 'input[name="name" i]', 'input[aria-label="Name" i]'], ME.full);
await set("Email",      ['input[type="email"]', 'input[name*="email" i]', 'input[id*="email" i]', 'input[autocomplete="email"]'], ME.email);
await set("Phone",      ['input[type="tel"]', 'input[name*="phone" i]'], ME.phone);
await set("Location",   ['input[name*="location" i]', 'input[id*="location" i]', 'input[placeholder*="city" i]', 'input[placeholder*="location" i]'], ME.location);
await set("LinkedIn",   ['input[name*="linkedin" i]', 'input[id*="linkedin" i]'], ME.linkedin);
await set("GitHub",     ['input[name*="github" i]', 'input[id*="github" i]'], ME.github);
await set("Website",    ['input[name*="website" i]', 'input[name*="portfolio" i]'], ME.portfolio);
if (fs.existsSync(CV)) await set("Résumé", ['input#_systemfield_resume', 'input[name*="resume" i]', 'input[id*="resume" i]', 'input[type="file"]'], CV, { type: "file" });
const coverField = page.locator('textarea[name*="cover" i], textarea[id*="cover" i]').first();
if (await coverField.count()) await set("Cover letter", ['textarea[name*="cover" i]', 'textarea[id*="cover" i]'], coverLetter);
else console.log("  (no cover-letter field on this form — it uses essay questions instead)\n");

// Long-form questions, matched to their own label rather than to page order.
// Running these as a separate script meant a second page load, which wiped the
// identity fields the first pass had just filled — one pass, or none.
const ESSAYS = process.argv
  .filter((a) => a.startsWith("--answer="))
  .map((a) => {
    const [keys, file] = a.slice(9).split(":");
    return { match: keys.split("|").map((k) => k.trim().toLowerCase()), file };
  });

// Long-form answers are matched to a textarea's own label, never to page order.
// Ashby is flaky enough that reading the value back is the only proof it landed:
// on three fills in August a different required field failed silently each time.
for (const area of await page.locator("textarea").all()) {
  if (!(await area.isVisible().catch(() => false))) continue;
  if ((await area.inputValue().catch(() => "")).length > 40) continue;
  const q = (await area.evaluate((el) => {
    const byFor = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    return (byFor?.innerText || el.getAttribute("aria-label") || el.closest("div,fieldset")?.innerText || "").slice(0, 400);
  }).catch(() => "")).toLowerCase();

  const hit = ESSAYS.find((e) => e.match.some((m) => q.includes(m)));
  if (!hit) { failed.push([`Unmatched question`, `"${q.slice(0, 55).replace(/\n/g, " ")}"`]); continue; }
  if (!fs.existsSync(hit.file)) { failed.push([hit.file, "answer file missing"]); continue; }
  const text = fs.readFileSync(hit.file, "utf8").trim();
  await area.scrollIntoViewIfNeeded();
  await area.fill(text, { timeout: 8000 });
  const got = await area.inputValue().catch(() => "");
  (got.length > 200 ? filled : failed).push([`Answer: ${hit.match[0].slice(0, 28)}`, got.length > 200 ? `${got.length} chars` : "did not stick"]);
}

console.log("  FILLED AND VERIFIED");
for (const [k, v] of filled) console.log(`    ✓ ${k.padEnd(14)} ${v}`);
if (failed.length) {
  console.log("\n  NOT FILLED — do these by hand");
  for (const [k, why] of failed) console.log(`    ✗ ${k.padEnd(14)} ${why}`);
}

// Anything still required and empty is the thing that silently sinks a submission.
const empties = await page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll("input,textarea,select")) {
    const req = el.required || el.getAttribute("aria-required") === "true";
    const label = el.labels?.[0]?.innerText || el.getAttribute("aria-label") || el.name || el.id;
    if (req && !el.value && el.type !== "file" && el.offsetParent !== null) out.push(String(label).slice(0, 70).replace(/\s+/g, " "));
  }
  return [...new Set(out)];
});
if (empties.length) {
  console.log("\n  STILL REQUIRED AND EMPTY");
  for (const e of empties) console.log(`    ! ${e}`);
}

console.log(`\n  The browser is open. Review every field, answer anything left, then submit yourself.`);
console.log(`  Nothing has been sent.\n`);
console.log(`  When you do send it:  node bin/shortlist.js mark ${job.id.slice(0, 8)} applied\n`);
await page.waitForTimeout(600000);
