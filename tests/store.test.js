import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as store from "../src/store.js";

/**
 * These test the idempotency claims the README makes. The store writes relative to
 * process.cwd(), so each run gets a throwaway directory.
 */
const origCwd = process.cwd();
let tmp;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shortlist-test-"));
  process.chdir(tmp);
});
after(() => { process.chdir(origCwd); });

const job = (over = {}) => ({
  company: "PostHog", title: "Backend Engineer", location: "Remote",
  url: "https://example.com/1", postedAt: "2026-08-06T00:00:00Z",
  description: "billing", score: 77, scoreSource: "llm", reason: "fits", against: "python",
  prescore: 60, tier: "strong", source: "ashby:posthog", ...over,
});

test("a second identical run adds nothing", async () => {
  const db = await store.load();
  const first = store.upsertAll(db, [job()]);
  const second = store.upsertAll(db, [job()]);
  assert.equal(first.added, 1);
  assert.equal(second.added, 0);
  assert.equal(second.updated, 1);
  assert.equal(Object.keys(db.jobs).length, 1);
});

test("re-running preserves firstSeenAt", async () => {
  const db = await store.load();
  store.upsertAll(db, [job()]);
  const first = Object.values(db.jobs)[0].firstSeenAt;
  await new Promise((r) => setTimeout(r, 5));
  store.upsertAll(db, [job()]);
  const row = Object.values(db.jobs)[0];
  assert.equal(row.firstSeenAt, first);
  assert.notEqual(row.lastSeenAt, first);
});

test("re-running never resets a status a human set", async () => {
  const db = await store.load();
  store.upsertAll(db, [job()]);
  const id = Object.keys(db.jobs)[0];
  store.setStatus(db, id, "applied");
  store.upsertAll(db, [job()]);
  assert.equal(db.jobs[id].status, "applied");
});

test("an ATS record replaces an aggregator mirror, not the other way round", async () => {
  const db = await store.load();
  store.upsertAll(db, [job({ tier: "feed", source: "remoteok", description: "short" })]);
  store.upsertAll(db, [job({ tier: "strong", source: "ashby:posthog", description: "the full posting" })]);
  const row = Object.values(db.jobs)[0];
  assert.equal(row.source, "ashby:posthog");

  store.upsertAll(db, [job({ tier: "feed", source: "remoteok", description: "short" })]);
  assert.equal(Object.values(db.jobs)[0].source, "ashby:posthog", "a feed must not overwrite an ATS record");
});

test("a job appears in exactly one digest", async () => {
  const db = await store.load();
  store.upsertAll(db, [job()]);
  const opts = { max: 15, threshold: 65 };
  const first = store.selectForDigest(db, opts);
  assert.equal(first.length, 1);
  store.markDigested(db, first, "2026-08-12");
  assert.equal(store.selectForDigest(db, opts).length, 0);
});

test("a job returns to the digest only if its score improved by 10 or more", async () => {
  const db = await store.load();
  store.upsertAll(db, [job({ score: 70 })]);
  const opts = { max: 15, threshold: 65 };
  store.markDigested(db, store.selectForDigest(db, opts), "2026-08-12");

  store.upsertAll(db, [job({ score: 75 })]);
  assert.equal(store.selectForDigest(db, opts).length, 0, "+5 is not enough");

  store.upsertAll(db, [job({ score: 85 })]);
  assert.equal(store.selectForDigest(db, opts).length, 1, "+15 should resurface it");
});

test("provisional scores are excluded once any model score exists", async () => {
  const db = await store.load();
  store.upsertAll(db, [
    job({ score: 90, scoreSource: "prescore", url: "https://example.com/p", title: "Lead ML Scientist" }),
    job({ score: 70, scoreSource: "llm" }),
  ]);
  const withLlm = store.selectForDigest(db, { max: 15, threshold: 65, llmOnly: true });
  assert.equal(withLlm.length, 1);
  assert.equal(withLlm[0].scoreSource, "llm", "a keyword score must not outrank a read one");

  const withoutLlm = store.selectForDigest(db, { max: 15, threshold: 65, llmOnly: false });
  assert.equal(withoutLlm.length, 2, "with no model scores at all, provisional entries are the fallback");
});

test("below-threshold jobs never reach the digest", async () => {
  const db = await store.load();
  store.upsertAll(db, [job({ score: 40 })]);
  assert.equal(store.selectForDigest(db, { max: 15, threshold: 65 }).length, 0);
});

test("the digest is capped at max", async () => {
  const db = await store.load();
  store.upsertAll(db, Array.from({ length: 30 }, (_, i) =>
    job({ title: `Backend Engineer ${i}`, url: `https://example.com/${i}` })));
  assert.equal(store.selectForDigest(db, { max: 15, threshold: 65 }).length, 15);
});

test("save then load round-trips", async () => {
  const db = await store.load();
  store.upsertAll(db, [job()]);
  await store.save(db);
  const again = await store.load();
  assert.equal(Object.keys(again.jobs).length, 1);
  assert.equal(Object.values(again.jobs)[0].title, "Backend Engineer");
});

test("save is atomic — no temp file is left behind", async () => {
  const db = await store.load();
  store.upsertAll(db, [job()]);
  await store.save(db);
  assert.ok(!fs.existsSync(path.join(tmp, "data", "jobs.json.tmp")));
  assert.ok(fs.existsSync(path.join(tmp, "data", "jobs.json")));
});

test("purge keeps anything a human has touched", async () => {
  const db = await store.load();
  store.upsertAll(db, [
    job({ url: "https://example.com/old", title: "Old Role" }),
    job({ url: "https://example.com/applied", title: "Applied Role" }),
  ]);
  for (const row of Object.values(db.jobs)) row.firstSeenAt = "2020-01-01T00:00:00Z";
  const appliedId = Object.values(db.jobs).find((j) => j.title === "Applied Role").id;
  store.setStatus(db, appliedId, "applied");

  const purged = store.purgeOlderThan(db, 30);
  assert.equal(purged, 1);
  assert.ok(db.jobs[appliedId], "an applied job must survive the purge");
});

test("setStatus accepts an id prefix, as the CLI passes", async () => {
  const db = await store.load();
  store.upsertAll(db, [job()]);
  const id = Object.keys(db.jobs)[0];
  const row = store.setStatus(db, id.slice(0, 8), "interested");
  assert.equal(row.status, "interested");
});

test("a changed hash function re-keys rows instead of orphaning them", async () => {
  const db = await store.load();
  store.upsertAll(db, [job()]);
  const realId = Object.keys(db.jobs)[0];

  // Simulate a row written by an older hash function.
  const stale = { ...db.jobs[realId], id: "deadbeefdeadbeef" };
  delete db.jobs[realId];
  db.jobs["deadbeefdeadbeef"] = stale;
  stale.status = "applied";

  const moved = store.migrateIds(db);
  assert.equal(moved, 1);
  assert.equal(db.jobs["deadbeefdeadbeef"], undefined);
  assert.equal(db.jobs[realId].status, "applied", "an applied status must survive re-keying");
  assert.equal(db.jobs[realId].id, realId);
});

test("merging two rows keeps the status furthest along and the earliest sighting", async () => {
  const db = await store.load();
  store.upsertAll(db, [job()]);
  const realId = Object.keys(db.jobs)[0];
  db.jobs[realId].status = "new";
  db.jobs[realId].firstSeenAt = "2026-08-10T00:00:00Z";

  db.jobs["staleid00000000"] = { ...db.jobs[realId], id: "staleid00000000", status: "applied", firstSeenAt: "2026-08-01T00:00:00Z" };

  store.migrateIds(db);
  assert.equal(Object.keys(db.jobs).length, 1);
  assert.equal(db.jobs[realId].status, "applied");
  assert.equal(db.jobs[realId].firstSeenAt, "2026-08-01T00:00:00Z");
});

test("migration never walks a status backwards", async () => {
  const db = await store.load();
  store.upsertAll(db, [job()]);
  const realId = Object.keys(db.jobs)[0];
  db.jobs[realId].status = "applied";
  db.jobs["staleid00000000"] = { ...db.jobs[realId], id: "staleid00000000", status: "new" };

  store.migrateIds(db);
  assert.equal(db.jobs[realId].status, "applied");
});

test("a keyword score never overwrites a score the model actually produced", async () => {
  const db = await store.load();
  store.upsertAll(db, [job({ score: 75, scoreSource: "llm", reason: "Read in full: billing infrastructure.", against: "Python stack." })]);
  const id = Object.keys(db.jobs)[0];

  // Next run: this job fell outside the top N, so it comes back keyword-scored.
  store.upsertAll(db, [job({ score: 90, scoreSource: "prescore", reason: "Keyword match only — domain: payment", against: "" })]);

  const row = db.jobs[id];
  assert.equal(row.score, 75, "the real score must survive");
  assert.equal(row.scoreSource, "llm");
  assert.match(row.reason, /Read in full/);
  assert.equal(row.against, "Python stack.");
});

test("a model score does replace an earlier keyword score", async () => {
  const db = await store.load();
  store.upsertAll(db, [job({ score: 60, scoreSource: "prescore", reason: "Keyword match only", against: "" })]);
  const id = Object.keys(db.jobs)[0];
  store.upsertAll(db, [job({ score: 77, scoreSource: "llm", reason: "Actually read.", against: "Real objection." })]);
  assert.equal(db.jobs[id].score, 77);
  assert.equal(db.jobs[id].scoreSource, "llm");
  assert.equal(db.jobs[id].reason, "Actually read.");
});

test("a status a human set is never invented by the pipeline", async () => {
  // My own test run once wrote 'applied' onto six of Victor's real jobs, which
  // silently removed his best match from every future digest. Nothing in the
  // pipeline path may set a status other than 'new'.
  const db = await store.load();
  store.upsertAll(db, [job(), job({ url: "https://example.com/2", title: "Other Role" })]);
  for (const row of Object.values(db.jobs)) {
    assert.equal(row.status, "new", "upsert must only ever create rows as new");
  }
  store.upsertAll(db, [job()]);
  assert.equal(Object.values(db.jobs).every((r) => r.status === "new"), true);
});

test("a row that never had a posted date gets one when the source starts supplying it", () => {
  const db = { version: 1, jobs: {}, digests: {} };
  const dateless = { company: "Acme", title: "Backend Engineer", location: "Remote", url: "u", tier: "feed", postedAt: null };
  store.upsertAll(db, [dateless]);
  const id = Object.keys(db.jobs)[0];
  assert.equal(db.jobs[id].postedAt, null);

  store.upsertAll(db, [{ ...dateless, postedAt: "2026-08-13T06:00:00.000Z" }]);
  assert.equal(db.jobs[id].postedAt, "2026-08-13T06:00:00.000Z");
});

test("an existing posted date is never overwritten by a later sighting", () => {
  const db = { version: 1, jobs: {}, digests: {} };
  const j = { company: "Acme", title: "Backend Engineer", location: "Remote", url: "u", tier: "feed", postedAt: "2026-07-01T00:00:00.000Z" };
  store.upsertAll(db, [j]);
  const id = Object.keys(db.jobs)[0];
  store.upsertAll(db, [{ ...j, postedAt: "2026-08-13T00:00:00.000Z" }]);
  assert.equal(db.jobs[id].postedAt, "2026-07-01T00:00:00.000Z");
});

test("a new field the scorer learns to produce reaches the store", async () => {
  // The merge was a hand-listed allow-list, so `odds` and `eligibility` were computed,
  // returned correctly, and silently dropped on every existing row.
  const db = await store.load();
  store.upsertAll(db, [job({ scoreSource: "llm" })]);
  const id = Object.keys(db.jobs)[0];

  store.upsertAll(db, [job({ scoreSource: "llm", odds: 62, eligibility: "eor", requirements_met: "7 of 9" })]);

  assert.equal(db.jobs[id].odds, 62);
  assert.equal(db.jobs[id].eligibility, "eor");
  assert.equal(db.jobs[id].requirements_met, "7 of 9");
});

test("a keyword pass still cannot erase a field a read produced", async () => {
  const db = await store.load();
  store.upsertAll(db, [job({ scoreSource: "llm", score: 70, odds: 55, eligibility: "eor" })]);
  const id = Object.keys(db.jobs)[0];
  store.upsertAll(db, [job({ scoreSource: "prescore", score: 90, odds: undefined, eligibility: undefined })]);
  assert.equal(db.jobs[id].odds, 55);
  assert.equal(db.jobs[id].eligibility, "eor");
  assert.equal(db.jobs[id].score, 70);
});
