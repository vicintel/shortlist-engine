import fs from "node:fs/promises";
import path from "node:path";
import { jobHash } from "./util.js";
import { SCORE_FIELDS } from "./providers/schema.js";

// Derived from the scoring schema itself, so a field added there flows through here
// without anyone remembering to update a list. A hand-maintained allow-list is what
// silently dropped `odds` and `eligibility` after the model started returning them.
const VERDICT_KEYS = [...Object.keys(SCORE_FIELDS), "scoreSource", "scoredBy", "scoredAt"];
const pickVerdict = (job) =>
  Object.fromEntries(VERDICT_KEYS.filter((k) => job[k] !== undefined).map((k) => [k, job[k]]));

// Provenance is everything that is NOT a verdict. Keeping the two disjoint is what
// stops a keyword pass smuggling its score in through the provenance spread.
const VERDICT_SET = new Set(VERDICT_KEYS);
const pickProvenance = (job) =>
  Object.fromEntries(Object.entries(job).filter(([k]) => !VERDICT_SET.has(k)));

// Resolved per call, not at import. Freezing these at module load meant the store
// ignored any later change of working directory — which silently pointed a test run
// at the real database.
const dataDir = () => path.join(process.cwd(), "data");
const dbPath = () => path.join(dataDir(), "jobs.json");

const empty = () => ({ version: 1, jobs: {}, digests: {} });

export async function load() {
  try {
    const db = JSON.parse(await fs.readFile(dbPath(), "utf8"));
    migrateIds(db);
    backfillHistory(db);
    return db;
  } catch (err) {
    if (err.code === "ENOENT") return empty();
    throw err;
  }
}

/**
 * Every status, in timeline order. The rank is what stops a merge walking a status
 * backwards, so it must stay ordered by "how far along the process is", not by mood.
 *
 * The split that matters: `rejected` is HIM passing on a role; `declined` is THEM
 * passing on him. Both used to be `rejected`, which made the only question worth
 * asking — "of the roles I applied to, how many said no?" — unanswerable. Existing
 * `rejected` rows are left alone; none of them carry an appliedAt, so they were all
 * self-rule-outs and the old meaning still reads correctly.
 */
export const STATUSES = [
  "new", "interested", "applied", "screen", "interview", "offer", "declined", "rejected", "closed",
];

/** Statuses that mean an employer actually came back. */
export const RESPONDED = new Set(["screen", "interview", "offer", "declined"]);

const STATUS_RANK = {
  new: 0, closed: 1, rejected: 2, interested: 3, applied: 4,
  screen: 5, interview: 6, declined: 7, offer: 8,
};

/**
 * Re-key rows whose stored id no longer matches their recomputed hash.
 *
 * Any change to jobHash silently orphans every existing row — the next run treats
 * them as new and a job already marked "applied" comes back as unseen. Re-keying on
 * load makes the hash safe to change; without it, the identity function is frozen
 * forever or human-set statuses get quietly lost.
 */
export function migrateIds(db) {
  let moved = 0;
  for (const [oldId, row] of Object.entries(db.jobs)) {
    const id = jobHash(row);
    if (id === oldId) continue;

    const existing = db.jobs[id];
    if (existing) {
      // Two rows collapse into one: keep the earliest sighting and the status
      // furthest along, so a merge can never walk a status backwards.
      if (new Date(row.firstSeenAt) < new Date(existing.firstSeenAt)) existing.firstSeenAt = row.firstSeenAt;
      if ((STATUS_RANK[row.status] ?? 0) > (STATUS_RANK[existing.status] ?? 0)) existing.status = row.status;
      existing.digestedAt = existing.digestedAt || row.digestedAt;
    } else {
      db.jobs[id] = { ...row, id };
    }
    delete db.jobs[oldId];
    moved += 1;
  }
  return moved;
}

export async function save(db) {
  await fs.mkdir(dataDir(), { recursive: true });
  // Write-then-rename so an interrupted run can never truncate the store.
  const target = dbPath();
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(db, null, 2));
  await fs.rename(tmp, target);
}

/**
 * Upsert scraped jobs. Deliberately idempotent: re-running the pipeline in the same
 * hour must not duplicate rows, reset a status, or move firstSeenAt. Only fields that
 * legitimately change on a re-scrape are overwritten.
 */
export function upsertAll(db, jobs) {
  const now = new Date().toISOString();
  let added = 0, updated = 0;

  for (const job of jobs) {
    const id = jobHash(job);
    const prev = db.jobs[id];

    if (!prev) {
      db.jobs[id] = { ...job, id, firstSeenAt: now, lastSeenAt: now, status: "new", digestedAt: null };
      added += 1;
      continue;
    }


    // Two different merge rules, because two different things are being merged.
    //
    // Provenance (source, description, url) follows the ATS-over-aggregator rule above:
    // the record closest to the employer wins, whoever scored it.
    //
    // The verdict (score, odds, eligibility, reasoning) follows a read-wins rule, and
    // is derived from the scoring schema so new fields arrive automatically.
    const isRead = job.scoreSource === "llm";
    const verdict = isRead || prev.scoreSource !== "llm" ? pickVerdict(job) : {};

    // Provenance updates on every re-scrape — config changes (a new `stage` tag) and
    // edited postings must reach existing rows. The one exception is the ATS-over-feed
    // rule: a feed's thin description must not replace an ATS record's full one.
    const provenance = prev.tier !== "feed" && job.tier === "feed" ? {} : pickProvenance(job);

    db.jobs[id] = {
      ...prev,
      ...provenance,
      ...verdict,
      id,
      // Owned by the human or by the row's own history — never by a scrape.
      firstSeenAt: prev.firstSeenAt,
      status: prev.status,
      statusAt: prev.statusAt,
      digestedAt: prev.digestedAt,
      digestedScore: prev.digestedScore,
      lastSeenAt: now,
      // Backfill a date onto rows that never had one. A dateless row skips the
      // freshness gate entirely.
      postedAt: prev.postedAt || job.postedAt || null,
      prescore: job.prescore ?? prev.prescore,
    };
    updated += 1;
  }

  return { added, updated };
}

/**
 * A job appears in exactly one digest. It only returns if its score improved by 10+,
 * which is the only case where re-reading it is worth the attention.
 */
export function selectForDigest(db, { max, threshold, rescoreDelta = 10, llmOnly = false }) {
  return Object.values(db.jobs)
    .filter((j) => {
      if (j.status !== "new") return false;
      // A provisional keyword score is not comparable to a model score. Once any
      // model score exists, letting the two share a ranking puts unread jobs above
      // read ones — which is how a UK-locked ML role reached the top of the digest.
      if (llmOnly && j.scoreSource !== "llm") return false;
      if ((j.score ?? -1) < threshold) return false;
      if (!j.digestedAt) return true;
      return (j.score ?? 0) - (j.digestedScore ?? 0) >= rescoreDelta;
    })
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, max);
}

export function markDigested(db, jobs, digestId) {
  const now = new Date().toISOString();
  for (const j of jobs) {
    const row = db.jobs[j.id];
    if (row) { row.digestedAt = now; row.digestedScore = row.score ?? 0; }
  }
  db.digests[digestId] = { at: now, ids: jobs.map((j) => j.id), count: jobs.length };
}

export function setStatus(db, id, status, note) {
  const row = db.jobs[id] || Object.values(db.jobs).find((j) => j.id.startsWith(id));
  if (!row) return null;
  const at = new Date().toISOString();

  // The dated trail, not just the latest label. Without it "applied on the 12th and
  // heard nothing since" is unanswerable, which is the whole reason 15 applications
  // produced no usable information.
  row.history = row.history || [];
  if (row.history[row.history.length - 1]?.status !== status) {
    row.history.push({ status, at, ...(note ? { note } : {}) });
  }

  // Stamped once, on the first move into applied. Every "how long has it been quiet"
  // question measures from here, so a later status change must not reset it.
  if (status === "applied" && !row.appliedAt) row.appliedAt = at;
  if (RESPONDED.has(status) && !row.respondedAt) row.respondedAt = at;

  row.status = status;
  row.statusAt = at;
  return row;
}

/**
 * Seed history for rows that predate it, so the funnel is not blind to the
 * applications already sent. Uses the dates already on the row rather than
 * inventing any: a row with no statusAt gets no history rather than a guess.
 */
export function backfillHistory(db) {
  let filled = 0;
  for (const row of Object.values(db.jobs)) {
    if (row.history?.length || row.status === "new") continue;
    const at = row.statusAt || row.firstSeenAt;
    if (!at) continue;
    row.history = [{ status: row.status, at, note: "backfilled from statusAt" }];
    if (row.status === "applied" && !row.appliedAt) row.appliedAt = at;
    filled += 1;
  }
  return filled;
}

const DAY = 86400000;
export const daysSince = (iso) => (iso ? Math.floor((Date.now() - new Date(iso).getTime()) / DAY) : null);

/**
 * What came back from the applications sent. The number this tool was missing.
 */
export function responseFunnel(db) {
  const jobs = Object.values(db.jobs);
  const applied = jobs.filter((j) => j.appliedAt || j.status === "applied" || RESPONDED.has(j.status));
  const responded = applied.filter((j) => RESPONDED.has(j.status) || j.respondedAt);
  const silent = applied
    .filter((j) => j.status === "applied" && !j.respondedAt)
    .map((j) => ({ ...j, quietDays: daysSince(j.appliedAt || j.statusAt) }))
    .sort((a, b) => (b.quietDays ?? 0) - (a.quietDays ?? 0));

  const byStatus = {};
  for (const j of applied) byStatus[j.status] = (byStatus[j.status] || 0) + 1;

  return {
    applied: applied.length,
    responded: responded.length,
    silent,
    byStatus,
    responseRate: applied.length ? responded.length / applied.length : null,
  };
}

export function purgeOlderThan(db, days) {
  const cutoff = Date.now() - days * 86400000;
  let purged = 0;
  for (const [id, j] of Object.entries(db.jobs)) {
    const keep = j.status !== "new" || new Date(j.firstSeenAt).getTime() > cutoff;
    if (!keep) { delete db.jobs[id]; purged += 1; }
  }
  return purged;
}
