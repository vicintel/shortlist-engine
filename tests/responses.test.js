import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as store from "../src/store.js";

/**
 * Response tracking — the half of the funnel that was never recorded.
 *
 * Before this, the last status a job could reach was `applied`. Fifteen applications
 * had gone out and the store could not answer "did anyone reply?", because there was
 * no status past applied and `rejected` meant both "I passed on this" and "they passed
 * on me". These tests pin the distinction and the dated trail that makes silence
 * measurable.
 */
const origCwd = process.cwd();
let tmp;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shortlist-resp-"));
  process.chdir(tmp);
});
after(() => { process.chdir(origCwd); });

const job = (over = {}) => ({
  company: "PostHog", title: "Backend Engineer", location: "Remote",
  url: "https://example.com/1", postedAt: "2026-08-06T00:00:00Z",
  description: "billing", score: 77, scoreSource: "llm", reason: "fits", against: "python",
  prescore: 60, tier: "strong", source: "ashby:posthog", ...over,
});

const seed = async (over) => {
  const db = await store.load();
  store.upsertAll(db, [job(over)]);
  return [db, Object.keys(db.jobs)[0]];
};

test("applying stamps appliedAt and starts the history trail", async () => {
  const [db, id] = await seed();
  store.setStatus(db, id, "applied");
  const row = db.jobs[id];
  assert.ok(row.appliedAt, "appliedAt must be stamped");
  assert.equal(row.history.length, 1);
  assert.equal(row.history[0].status, "applied");
});

test("a later stage does not reset appliedAt", async () => {
  // Every "how long has this been quiet" answer measures from the application date.
  // Resetting it on each move would make a slow process look instant.
  const [db, id] = await seed();
  store.setStatus(db, id, "applied");
  const applied = db.jobs[id].appliedAt;
  store.setStatus(db, id, "screen");
  store.setStatus(db, id, "interview");
  assert.equal(db.jobs[id].appliedAt, applied);
  assert.equal(db.jobs[id].history.length, 3);
});

test("declined and rejected are different facts", async () => {
  // rejected = he passed on the role. declined = the employer passed on him.
  // Collapsing them is what made the response rate unanswerable.
  const [db, a] = await seed();
  store.upsertAll(db, [job({ url: "https://example.com/2", company: "Oyster" })]);
  const b = Object.keys(db.jobs).find((k) => k !== a);

  store.setStatus(db, a, "rejected");            // never applied — he passed
  store.setStatus(db, b, "applied");
  store.setStatus(db, b, "declined");            // applied — they passed

  const f = store.responseFunnel(db);
  assert.equal(f.applied, 1, "the role he passed on was never applied to");
  assert.equal(f.responded, 1);
  assert.equal(f.byStatus.declined, 1);
});

test("responseFunnel counts an employer reply as a response", async () => {
  const [db, id] = await seed();
  store.setStatus(db, id, "applied");
  assert.equal(store.responseFunnel(db).responded, 0);
  store.setStatus(db, id, "screen");
  const f = store.responseFunnel(db);
  assert.equal(f.responded, 1);
  assert.equal(f.responseRate, 1);
});

test("silence is reported with an age, longest first", async () => {
  const db = await store.load();
  store.upsertAll(db, [job({ url: "https://e.com/1", company: "Old" }), job({ url: "https://e.com/2", company: "Recent" })]);
  const [a, b] = Object.keys(db.jobs);
  store.setStatus(db, a, "applied");
  store.setStatus(db, b, "applied");
  db.jobs[a].appliedAt = new Date(Date.now() - 30 * 86400000).toISOString();
  db.jobs[b].appliedAt = new Date(Date.now() - 2 * 86400000).toISOString();

  const f = store.responseFunnel(db);
  assert.equal(f.silent.length, 2);
  assert.equal(f.silent[0].quietDays, 30, "the longest silence must come first");
  assert.equal(f.silent[1].quietDays, 2);
});

test("a job that got a reply is not counted as silent", async () => {
  const [db, id] = await seed();
  store.setStatus(db, id, "applied");
  store.setStatus(db, id, "interview");
  assert.equal(store.responseFunnel(db).silent.length, 0);
});

test("backfill gives existing applications a history without inventing dates", async () => {
  // The 15 applications already sent predate history entirely. They carry statusAt,
  // so that is what seeds the trail — a row with no date gets nothing, not a guess.
  const [db, id] = await seed();
  db.jobs[id].status = "applied";
  db.jobs[id].statusAt = "2026-08-12T09:00:00.000Z";

  store.upsertAll(db, [job({ url: "https://e.com/3", company: "NoDate" })]);
  const undated = Object.keys(db.jobs).find((k) => k !== id);
  db.jobs[undated].status = "applied";
  delete db.jobs[undated].statusAt;
  delete db.jobs[undated].firstSeenAt;

  const filled = store.backfillHistory(db);
  assert.equal(filled, 1, "only the row with a real date should be backfilled");
  assert.equal(db.jobs[id].appliedAt, "2026-08-12T09:00:00.000Z");
  assert.equal(db.jobs[id].history[0].status, "applied");
  assert.ok(!db.jobs[undated].history, "a dateless row must not get an invented history");
});

test("backfill is idempotent", async () => {
  const [db, id] = await seed();
  db.jobs[id].status = "applied";
  db.jobs[id].statusAt = "2026-08-12T09:00:00.000Z";
  store.backfillHistory(db);
  const again = store.backfillHistory(db);
  assert.equal(again, 0);
  assert.equal(db.jobs[id].history.length, 1);
});

test("re-marking the same status does not pad the history", async () => {
  const [db, id] = await seed();
  store.setStatus(db, id, "applied");
  store.setStatus(db, id, "applied");
  assert.equal(db.jobs[id].history.length, 1);
});

test("a merge never walks a status back from a reply stage", async () => {
  // migrateIds collapses two rows into one and keeps the status furthest along. An
  // interview must never be overwritten by the plain `applied` side of the merge.
  const [db, id] = await seed();
  store.setStatus(db, id, "interview");
  const row = db.jobs[id];
  const clone = { ...row, id: "stale-id", status: "applied" };
  db.jobs["stale-id"] = clone;

  store.migrateIds(db);
  const survivor = Object.values(db.jobs)[0];
  assert.equal(Object.keys(db.jobs).length, 1);
  assert.equal(survivor.status, "interview");
});
