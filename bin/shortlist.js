#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { run, loadConfig } from "../src/pipeline.js";
import * as store from "../src/store.js";
import { sendDigest, renderHTML, renderText, writeDigestFiles, digestSubject } from "../src/digest.js";
import { createMailer, explainMailError } from "../src/mail.js";
import { checkSlop, sendableText } from "../src/slop.js";
import { getJSON } from "../src/util.js";
import { createServer } from "../src/server.js";
import { buildKit, renderKit, writeKit } from "../src/apply.js";
import { createProvider } from "../src/providers/index.js";

// Minimal .env loader — one file, no dependency.
const envPath = path.join(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const args = process.argv.slice(2);
const cmd = args[0] || "run";
const has = (f) => args.includes(f);
const B = (s) => `\x1b[1m${s}\x1b[0m`;
const DIM = (s) => `\x1b[2m${s}\x1b[0m`;
const GREEN = (s) => `\x1b[32m${s}\x1b[0m`;

const STATUS_COLOURS = { new: "\x1b[36m", interested: "\x1b[32m", applied: "\x1b[35m", rejected: "\x1b[31m", closed: "\x1b[2m" };

async function cmdRun() {
  const result = await run({
    llmBudget: Number(process.env.SHORTLIST_LLM_BUDGET || 150),
    skipLLM: has("--no-llm"),
    verify: !has("--no-verify"),
  });

  const { shortlist, meta, db } = result;
  console.log(`\n${B("SHORTLIST")}  ${shortlist.length} role(s) scoring ${meta.threshold}+\n`);

  if (!shortlist.length) {
    console.log(DIM("  Nothing cleared the bar. An empty digest beats a padded one.\n"));
  } else {
    if (shortlist.some((j) => j.scoreSource === "prescore")) {
      console.log(DIM("  ~ = provisional keyword score; LLM scoring unavailable\n"));
    }
    for (const [i, j] of shortlist.entries()) {
      const mark = j.scoreSource === "prescore" ? "~" : " ";
      console.log(`  ${mark}${GREEN(String(j.score).padStart(3))} ${B(j.title)}`);
      console.log(`       ${j.company} · ${j.location || "location not stated"}${j.salaryText ? ` · ${j.salaryText}` : ""}${j.ageDays !== null ? ` · ${j.ageDays}d` : ""}`);
      console.log(`       ${j.reason}`);
      if (j.against) console.log(`       \x1b[31magainst:\x1b[0m ${j.against}`);
      console.log(DIM(`       ${j.url}`));
      console.log(DIM(`       id ${j.id}`));
      if (i < shortlist.length - 1) console.log();
    }
  }

  if (has("--html")) {
    const { dated, latest } = writeDigestFiles(shortlist, meta);
    console.log(`\n  ${GREEN("✓")} ${dated}`);
    console.log(DIM(`    bookmark: file://${latest}`));
    if (has("--open")) (await import("node:child_process")).execFile("open", [latest]);
  }

  if (has("--email")) {
    const mailer = createMailer(process.env);
    if (!mailer) {
      console.log(DIM("\n  --email skipped: no mail credentials set (see .env.example)"));
    } else {
      const digestId = new Date().toISOString().slice(0, 10);
      if (db.digests[digestId]) {
        console.log(DIM(`\n  digest ${digestId} already sent — skipping (idempotent)`));
      } else {
        try {
          await sendDigest(shortlist, meta, mailer);
          store.markDigested(db, shortlist, digestId);
          await store.save(db);
          console.log(`\n  ${GREEN("✓")} emailed via ${mailer.name} to ${mailer.to}`);
        } catch (err) {
          console.log(`\n  \x1b[31m✗ email failed\x1b[0m ${explainMailError(err)}`);
        }
      }
    }
  }

  console.log(DIM(`\n  ${meta.scanned} scanned → ${meta.filtered} filtered → ${meta.llmScored} read → ${shortlist.length} shortlisted · ${meta.elapsed}s · ${meta.cost}\n`));
}

async function cmdList() {
  const db = await store.load();
  const want = args[1];
  const rows = Object.values(db.jobs)
    .filter((j) => (want ? j.status === want : j.status === "new"))
    .filter((j) => j.score !== null && j.score !== undefined)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 40);
  if (!rows.length) return console.log(`\n  no ${want || "new"} jobs with a score yet — run \`npm run run\` first\n`);
  console.log();
  for (const j of rows) {
    const c = STATUS_COLOURS[j.status] || "";
    console.log(`  ${String(j.score).padStart(3)}  ${DIM(j.id)}  ${c}${j.status.padEnd(10)}\x1b[0m ${j.title} ${DIM("—")} ${j.company}`);
  }
  console.log(DIM(`\n  mark one:  node bin/shortlist.js mark <id> ${store.STATUSES.join("|")}\n`));
}

async function cmdMark() {
  const [, id, status, ...rest] = args;
  const note = rest.join(" ").trim() || undefined;
  if (!id || !store.STATUSES.includes(status)) {
    console.log(`\n  usage: mark <id> ${store.STATUSES.join("|")} [note]\n`);
    console.log(`  ${DIM("before applying")}  interested · rejected ${DIM("(you passed)")} · closed ${DIM("(posting gone)")}`);
    console.log(`  ${DIM("after applying")}   screen · interview · offer · declined ${DIM("(they passed)")}\n`);
    return;
  }
  const db = await store.load();
  const row = store.setStatus(db, id, status, note);
  if (!row) return console.log(`\n  no job with id ${id}\n`);
  await store.save(db);
  const quiet = row.appliedAt && store.RESPONDED.has(status)
    ? DIM(`  (${store.daysSince(row.appliedAt)}d after applying)`) : "";
  console.log(`\n  ${GREEN("✓")} ${row.title} — ${row.company} → ${status}${quiet}\n`);
}

async function cmdStats() {
  const db = await store.load();
  const jobs = Object.values(db.jobs);
  const by = (k) => jobs.reduce((a, j) => ((a[j[k] ?? "—"] = (a[j[k] ?? "—"] || 0) + 1), a), {});
  const scored = jobs.filter((j) => typeof j.score === "number");
  console.log(`\n  ${B("tracked")}      ${jobs.length}`);
  console.log(`  ${B("scored")}       ${scored.length}`);
  if (scored.length) {
    const s = scored.map((j) => j.score).sort((a, b) => b - a);
    console.log(`  ${B("score")}        max ${s[0]} · median ${s[Math.floor(s.length / 2)]} · ≥70 ${s.filter((x) => x >= 70).length}`);
  }
  console.log(`\n  ${B("by status")}`);
  for (const [k, v] of Object.entries(by("status"))) console.log(`    ${String(v).padStart(5)}  ${k}`);

  // What came back. Sending applications is the easy half to measure; this is the half
  // that tells him whether the funnel is working or just busy.
  const f = store.responseFunnel(db);
  console.log(`\n  ${B("responses")}`);
  if (!f.applied) {
    console.log(`    nothing applied to yet`);
  } else {
    const pct = f.responseRate === null ? "—" : `${Math.round(f.responseRate * 100)}%`;
    console.log(`    ${String(f.applied).padStart(5)}  applied`);
    console.log(`    ${String(f.responded).padStart(5)}  heard back  ${DIM(pct)}`);
    for (const s of ["screen", "interview", "offer", "declined"]) {
      if (f.byStatus[s]) console.log(`    ${String(f.byStatus[s]).padStart(5)}  ${s}`);
    }
    if (f.silent.length) {
      console.log(`\n  ${B("silent since applying")}`);
      for (const j of f.silent.slice(0, 10)) {
        const d = j.quietDays === null ? "  ?" : String(j.quietDays).padStart(3);
        console.log(`    ${d}d  ${String(j.company || "?").slice(0, 22).padEnd(23)} ${DIM(String(j.title || "").slice(0, 40))}`);
      }
      if (f.silent.length > 10) console.log(DIM(`    …and ${f.silent.length - 10} more`));
    }
  }
  console.log(`\n  ${B("digests sent")} ${Object.keys(db.digests).length}\n`);
}

/** Probe candidate ATS slugs so the watchlist only ever contains boards that resolve. */
async function cmdDiscover() {
  const slugs = args.slice(1);
  if (!slugs.length) return console.log("\n  usage: discover <slug> [slug...]\n");
  const apis = [
    ["greenhouse", (s) => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`, (j) => (j.jobs || []).length],
    ["lever", (s) => `https://api.lever.co/v0/postings/${s}?mode=json`, (j) => (Array.isArray(j) ? j.length : 0)],
    ["ashby", (s) => `https://api.ashbyhq.com/posting-api/job-board/${s}`, (j) => (j.jobs || []).length],
  ];
  console.log();
  await Promise.all(slugs.flatMap((s) => apis.map(async ([ats, url, count]) => {
    try {
      const n = count(await getJSON(url(s), { timeout: 12000 }));
      if (n > 0) console.log(`  ${GREEN("✓")} ${ats.padEnd(11)} ${s.padEnd(22)} ${n} jobs`);
    } catch { /* not on this ATS */ }
  })));
  console.log(DIM("\n  add any hits to config/companies.json → boards[]\n"));
}

async function cmdUi() {
  const port = Number(process.env.PORT || 4321);
  createServer().listen(port, () => {
    console.log(`\n  ${GREEN("✓")} dashboard on ${B(`http://localhost:${port}`)}   ${DIM("ctrl-c to stop")}\n`);
  });
}

async function cmdApply() {
  const id = args[1];
  if (!id) return console.log("\n  usage: apply <id> [--open]   (get ids from `npm run list`)\n");

  const db = await store.load();
  const job = db.jobs[id] || Object.values(db.jobs).find((j) => j.id.startsWith(id));
  if (!job) return console.log(`\n  no job with id ${id}\n`);

  const provider = createProvider(process.env);
  if (!provider) return console.log("\n  no provider key found — set GEMINI_API_KEY in .env\n");

  const { profile } = await loadConfig();
  console.log(`\n  ${B(job.title)} — ${job.company}`);
  console.log(DIM(`  drafting with ${provider.name}/${provider.model}…`));

  const { kit, usage, falseClaims } = await buildKit(job, { profile, provider });
  if (falseClaims.length) {
    console.log(`\n  \x1b[31m✗ ${falseClaims.length} false claim(s) — kit NOT written\x1b[0m`);
    for (const c of falseClaims) console.log(`      ${B(c.term)}: ${DIM(c.truth)}`);
    console.log(DIM(`\n  The posting named these, so the model claimed them. Re-run to redraft.\n`));
    return;
  }
  const md = renderKit(job, kit, {
    model: `${provider.name}/${provider.model}`,
    date: new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }),
  });
  const file = writeKit(job, md);

  console.log(`\n  ${GREEN("✓")} ${file}`);
  console.log(DIM(`  ${usage.input} in / ${usage.output} out tokens${provider.free ? " · free" : ""}\n`));
  console.log(md.split("## Cover letter")[1].split("---")[0].trim().split("\n").map((l) => "  " + l).join("\n"));
  console.log(DIM(`\n  full kit in the file above · when you send it:  node bin/shortlist.js mark ${job.id} applied\n`));

  if (has("--open")) (await import("node:child_process")).execFile("open", [file]);
}

async function cmdMailTest() {
  const mailer = createMailer(process.env);
  if (!mailer) {
    return console.log("\n  no mail credentials set. For Gmail, add GMAIL_USER and GMAIL_APP_PASSWORD to .env\n  app password: https://myaccount.google.com/apppasswords\n");
  }
  console.log(`\n  transport: ${B(mailer.name)}`);
  try {
    console.log(DIM("  verifying credentials…"));
    console.log(`  ${GREEN("✓")} ${await mailer.verify()}`);
  } catch (err) {
    return console.log(`  \x1b[31m✗\x1b[0m ${explainMailError(err)}\n`);
  }
  try {
    const sample = [{ score: 77, title: "Backend Engineer", company: "Example Co", location: "Remote", url: "https://example.com",
                      ageDays: 6, salaryText: "", reason: "Test send from Shortlist — the pipeline is wired up.", against: "" }];
    const meta = { date: new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }),
                   scanned: 0, filtered: 0, llmScored: 0, threshold: 65, model: "test", cost: "free" };
    const res = await sendDigest(sample, meta, mailer);
    console.log(`  ${GREEN("✓")} test email sent${res.id ? DIM(` (${res.id})`) : ""} — check ${mailer.to}\n`);
  } catch (err) {
    console.log(`  \x1b[31m✗ send failed\x1b[0m ${explainMailError(err)}\n`);
  }
}

async function cmdSlop() {
  const dir = path.join(process.cwd(), "data", "applications");
  if (!fs.existsSync(dir)) return console.log("\n  no application kits yet — run `npm run apply -- <id>`\n");
  const only = args[1];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md") && (!only || f.includes(only)));
  if (!files.length) return console.log(`\n  no kit matching ${only}\n`);

  let total = 0;
  for (const f of files) {
    const findings = checkSlop(sendableText(fs.readFileSync(path.join(dir, f), "utf8")));
    total += findings.length;
    const name = f.replace(/-[0-9a-f]{8}\.md$/, "");
    if (!findings.length) { console.log(`\n  ${GREEN("✓")} ${name}`); continue; }
    console.log(`\n  \x1b[33m${findings.length}\x1b[0m ${B(name)}`);
    for (const x of findings) {
      console.log(`      ${DIM(x.kind.padEnd(18))} ${x.note}`);
      if (x.match) console.log(`      ${DIM("  " + x.match)}`);
    }
  }
  console.log(DIM(`\n  ${total} flag(s). These are prompts to look, not verdicts — a factual contrast reads`));
  console.log(DIM(`  the same as a rhetorical one to a regex. Judge each on whether you'd say it aloud.\n`));
}

const COMMANDS = { run: cmdRun, slop: cmdSlop, "mail-test": cmdMailTest, ui: cmdUi, apply: cmdApply, list: cmdList, mark: cmdMark, stats: cmdStats, discover: cmdDiscover };

const fn = COMMANDS[cmd];
if (!fn) {
  console.log(`\n  shortlist — job funnel\n
  run [--email] [--html]     collect, score, shortlist
      [--no-llm]             (--html writes data/digest-<date>.html)
  ui                         open the dashboard on :4321
  apply <id> [--open]        draft an application kit for one role
  list [status]              show tracked jobs (default: new)
  mark <id> <status>         new|interested|applied|rejected|closed
  slop [name]                screen kits for tells of machine writing\n  mail-test                  verify email credentials and send one test
  stats                      pipeline counts
  discover <slug...>         test candidate ATS board slugs\n`);
  process.exit(1);
}
fn().catch((err) => { console.error(`\n  \x1b[31merror\x1b[0m ${err.stack || err.message}\n`); process.exit(1); });
