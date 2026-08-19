import fs from "node:fs/promises";
import path from "node:path";
import { fetchATS } from "./sources/ats.js";
import { fetchFeeds } from "./sources/feeds.js";
import { fetchGmailAlerts } from "./sources/gmail.js";
import { hardFilter } from "./filter.js";
import { prescoreAll } from "./prescore.js";
import { scoreWithLLM } from "./llmScore.js";
import { createProvider, estimateCost } from "./providers/index.js";
import * as store from "./store.js";
import { jobHash } from "./util.js";
import { verifyAll } from "./verify.js";

const readJSON = async (p) => JSON.parse(await fs.readFile(path.join(process.cwd(), p), "utf8"));

export async function loadConfig() {
  const [profile, companies, rules] = await Promise.all([
    readJSON("config/profile.json"),
    readJSON("config/companies.json"),
    readJSON("config/rules.json"),
  ]);
  return { profile, companies, rules };
}

/** Readable stand-in for the model's one-line verdict when scoring is unavailable. */
function provisionalReason(j) {
  const h = j.prescoreHits || { domain: [], stack: [], ai: [] };
  const bits = [];
  if (h.domain?.length) bits.push(`domain: ${h.domain.slice(0, 4).join(", ")}`);
  if (h.stack?.length) bits.push(`stack: ${h.stack.slice(0, 4).join(", ")}`);
  if (h.ai?.length) bits.push(`ai: ${h.ai.slice(0, 3).join(", ")}`);
  return bits.length ? `Keyword match only: ${bits.join(" · ")}` : "Keyword match only: no strong signals.";
}

/** Collapse duplicates within a single run, keeping the record closest to the employer. */
function dedupe(jobs) {
  const byHash = new Map();
  for (const job of jobs) {
    const id = jobHash(job);
    const prev = byHash.get(id);
    if (!prev) { byHash.set(id, job); continue; }
    const prevIsFeed = prev.tier === "feed";
    const thisIsFeed = job.tier === "feed";
    if (prevIsFeed && !thisIsFeed) byHash.set(id, job);
    else if (prevIsFeed === thisIsFeed && (job.description || "").length > (prev.description || "").length) byHash.set(id, job);
  }
  return [...byHash.values()];
}

export async function run({ log = console.log, llmBudget, skipLLM = false, verify = true, env = process.env } = {}) {
  const cfg = await loadConfig();
  const t0 = Date.now();
  const provider = skipLLM ? null : createProvider(env);
  const model = provider ? `${provider.name}:${provider.model}` : "none";

  log("\n\x1b[1mCOLLECT\x1b[0m");
  const [ats, feeds, alerts] = await Promise.all([
    fetchATS(cfg.companies.boards, log),
    fetchFeeds(null, log),
    // LinkedIn has no public API and blocks crawlers, so the only legitimate route is
    // their own alert emails, read back out of his own inbox. Self-skips without creds.
    fetchGmailAlerts({ env, log }),
  ]);
  const raw = [...ats, ...feeds, ...alerts];
  log(`  ${"total".padEnd(28)}${raw.length} jobs`);

  const deduped = dedupe(raw);
  log(`\n\x1b[1mDEDUPE\x1b[0m\n  ${raw.length} → ${deduped.length} (${raw.length - deduped.length} duplicates collapsed)`);

  const { kept, reasons } = hardFilter(deduped, cfg);
  log(`\n\x1b[1mFILTER\x1b[0m\n  ${deduped.length} → ${kept.length} passed`);
  Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 8)
    .forEach(([r, n]) => log(`    ${String(n).padStart(5)}  ${r}`));

  const ranked = prescoreAll(kept, cfg);
  log(`\n\x1b[1mPRESCORE\x1b[0m\n  top prescore ${ranked[0]?.prescore ?? 0}, median ${ranked[Math.floor(ranked.length / 2)]?.prescore ?? 0}`);

  let scored = ranked;
  let usage = { input: 0, output: 0, calls: 0, failed: 0 };
  let cost = 0;

  if (provider && ranked.length) {
    const batch = ranked.slice(0, llmBudget);
    const tag = provider.free ? "\x1b[32mfree\x1b[0m" : "\x1b[33mpaid\x1b[0m";
    log(`\n\x1b[1mSCORE\x1b[0m  ${batch.length} of ${ranked.length} → ${provider.name}/${provider.model} (${tag})`);
    const res = await scoreWithLLM(batch, {
      profile: cfg.profile, provider,
      onProgress: (d, t) => process.stdout.write(`\r  scoring ${d}/${t}   `),
    });
    process.stdout.write("\r" + " ".repeat(28) + "\r");
    usage = res.usage;
    cost = estimateCost(usage, provider.model);
    scored = [...res.scored, ...ranked.slice(llmBudget)];
    log(`  ${usage.calls} scored, ${usage.failed} failed · ${usage.input} in / ${usage.output} out tokens · ${cost ? `$${cost.toFixed(4)}` : "free"}`);
    if (usage.firstError) log(`  \x1b[31m✗ ${usage.firstError}\x1b[0m`);
  } else if (!skipLLM && !provider) {
    log(`\n\x1b[1mSCORE\x1b[0m  skipped — no provider key found (set GEMINI_API_KEY for the free tier).`);
  }

  // Without a usable LLM score the tool must still rank and shortlist, or a billing
  // problem silently becomes "no jobs today". Provisional scores are marked as such.
  scored = scored.map((j) =>
    typeof j.score === "number"
      ? { ...j, scoreSource: "llm" }
      : { ...j, score: Math.min(100, Math.round(j.prescore * 0.9)), scoreSource: "prescore",
          reason: j.reason || provisionalReason(j) }
  );

  const db = await store.load();
  const { added, updated } = store.upsertAll(db, scored);
  const purged = store.purgeOlderThan(db, 365);
  await store.save(db);
  log(`\n\x1b[1mSTORE\x1b[0m\n  ${added} new, ${updated} updated, ${purged} purged · ${Object.keys(db.jobs).length} tracked total`);

  // Over-select, then verify. Checking only `max` would let one dead link shrink the
  // digest below what the store could actually offer.
  const candidates = store.selectForDigest(db, {
    max: cfg.rules.digest.max * 2 + 5,
    threshold: cfg.rules.digest.scoreThreshold,
    llmOnly: usage.calls > 0,
  });

  let shortlist = candidates.slice(0, cfg.rules.digest.max);
  let verified = { checked: 0, dead: 0, unknown: 0 };

  if (verify && candidates.length) {
    log(`\n\x1b[1mVERIFY\x1b[0m  ${candidates.length} candidate links`);
    const results = await verifyAll(candidates);
    const dead = results.filter((r) => r.state === "dead");

    for (const r of dead) {
      // "closed" is an existing terminal status: it survives the purge and
      // selectForDigest never offers it again.
      store.setStatus(db, r.job.id, "closed");
      const row = db.jobs[r.job.id];
      if (row) { row.deadReason = r.reason; row.verifiedAt = new Date().toISOString(); }
      log(`  \x1b[31m✗\x1b[0m ${r.job.company} — ${r.job.title}\n      ${r.reason}`);
    }
    if (dead.length) await store.save(db);

    verified = {
      checked: results.length,
      dead: dead.length,
      unknown: results.filter((r) => r.state === "unknown").length,
    };
    // Unreachable ≠ closed. Keep those in, or one bad connection empties the digest.
    shortlist = results.filter((r) => r.state !== "dead").map((r) => r.job).slice(0, cfg.rules.digest.max);
    log(`  ${verified.checked - verified.dead} live, ${verified.dead} dead, ${verified.unknown} unreachable (kept)`);
  }

  return {
    db, shortlist, cost, usage, model, verified,
    meta: {
      scanned: raw.length,
      deduped: deduped.length,
      filtered: kept.length,
      llmScored: usage.calls,
      sources: cfg.companies.boards.length + 4,
      threshold: cfg.rules.digest.scoreThreshold,
      model,
      cost: cost ? `$${cost.toFixed(4)}` : "free",
      date: new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }),
      elapsed: ((Date.now() - t0) / 1000).toFixed(1),
    },
  };
}
