import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { hardFilter } from "../src/filter.js";
import { prescoreAll } from "../src/prescore.js";

/**
 * profile.json and companies.json are gitignored — they hold your salary floor and the
 * list of companies you are targeting. Fall back to the checked-in examples so a fresh
 * clone can run `npm test` before it has been configured at all. The filters under test
 * do not depend on their contents, only on their shape.
 */
const readConfig = (name) => {
  for (const candidate of [`../config/${name}.json`, `../config/${name}.example.json`]) {
    try {
      return JSON.parse(fs.readFileSync(new URL(candidate, import.meta.url)));
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
  throw new Error(`no config/${name}.json and no config/${name}.example.json`);
};

const profile = readConfig("profile");
const rules = readConfig("rules");
const companies = readConfig("companies");
const ctx = { profile, rules, companies };

const job = (over = {}) => ({
  company: "Acme",
  title: "Backend Engineer",
  location: "Remote",
  url: "https://example.com/1",
  postedAt: new Date().toISOString(),
  description: "Node.js, webhooks, payments.",
  tags: [],
  tier: "strong",
  ...over,
});

const keptTitles = (jobs) => hardFilter(jobs, ctx).kept.map((j) => j.title);

test("a plain engineering role passes", () => {
  assert.deepEqual(keptTitles([job()]), ["Backend Engineer"]);
});

test("a non-engineering title is rejected however good the description", () => {
  // Regression: Vercel's boilerplate names payments and ledgers on every posting,
  // which floated a Senior Accountant role to the top of a keyword ranking.
  const accountant = job({
    title: "Senior Accountant",
    description: "Vercel powers payments, ledgers, reconciliation, billing and commerce at scale.",
  });
  assert.deepEqual(keptTitles([accountant]), []);
});

test("a German working-student post is rejected", () => {
  assert.deepEqual(keptTitles([job({ title: "Werkstudent Development & AI Engineering" })]), []);
});

test("scientist and researcher titles are rejected", () => {
  assert.deepEqual(keptTitles([job({ title: "Machine Learning Scientist" })]), []);
  assert.deepEqual(keptTitles([job({ title: "Research Engineer, Applied ML" })]), []);
});

test("a leading seniority band above target is rejected", () => {
  for (const t of ["Staff Core Platform Engineer", "Principal Engineer", "Lead Backend Engineer", "Head of Platform"]) {
    assert.deepEqual(keptTitles([job({ title: t })]), [], `${t} should be rejected`);
  }
});

test("'tech lead' in the middle of a title is not treated as a leading band", () => {
  assert.deepEqual(keptTitles([job({ title: "Senior Engineer / Tech Lead" })]), ["Senior Engineer / Tech Lead"]);
});

test("remote but country-locked is rejected", () => {
  for (const loc of ["Remote - India", "Remote: United States, Remote: Canada", "Remote (Poland)", "Berlin Office"]) {
    assert.deepEqual(keptTitles([job({ location: loc })]), [], `${loc} should be rejected`);
  }
});

test("remote with a global or EMEA token is kept", () => {
  for (const loc of ["Remote - Global", "Remote (EMEA)", "Anywhere", "Remote, Worldwide"]) {
    assert.equal(keptTitles([job({ location: loc })]).length, 1, `${loc} should be kept`);
  }
});

test("onsite in Nigeria is kept even though onsite is otherwise ineligible", () => {
  assert.equal(keptTitles([job({ location: "Lagos, Nigeria" })]).length, 1);
  assert.equal(keptTitles([job({ location: "On-site — Abuja" })]).length, 1);
});

test("dealbreaker phrases reject before scoring", () => {
  const j = job({ description: "Applicants must hold an active security clearance." });
  const { kept, reasons } = hardFilter([j], ctx);
  assert.equal(kept.length, 0);
  assert.ok(Object.keys(reasons).some((r) => r.includes("security clearance")));
});

test("genuinely ancient postings are dropped", () => {
  // The window is 90 days now, not 21. Age is a poor proxy for "still open" —
  // startup roles stay live for months — and the link verifier checks liveness
  // directly. Recency is a ranking signal, not a death sentence.
  assert.deepEqual(keptTitles([job({ postedAt: new Date(Date.now() - 200 * 86400000).toISOString() })]), []);
});

test("a two-month-old posting survives, because open roles stay open", () => {
  assert.equal(keptTitles([job({ postedAt: new Date(Date.now() - 60 * 86400000).toISOString() })]).length, 1);
});

test("a posting with no date is kept — unknown is not the same as stale", () => {
  assert.equal(keptTitles([job({ postedAt: null })]).length, 1);
});

test("records missing a url or company are dropped", () => {
  assert.deepEqual(keptTitles([job({ url: "" })]), []);
  assert.deepEqual(keptTitles([job({ company: "" })]), []);
});

test("rejection reasons are counted so an over-firing rule is visible", () => {
  const { reasons } = hardFilter([job({ title: "Senior Accountant" }), job({ title: "Staff Engineer" })], ctx);
  assert.equal(Object.values(reasons).reduce((a, b) => a + b, 0), 2);
});

test("prescore ranks a payments role above a generic one", () => {
  const payments = job({ title: "Backend Engineer", description: "Payments, idempotent payouts, ledger reconciliation, webhooks, Node.js, billing." });
  const generic = job({ title: "Backend Engineer", url: "https://example.com/2", description: "We use some technology to do some things." });
  const [top] = prescoreAll(hardFilter([generic, payments], ctx).kept, ctx);
  assert.match(top.description, /Payments/);
});

test("prescore records which terms matched, so a score can be explained", () => {
  // Pinned to a fixture profile rather than whatever config/profile.json holds. Asserting
  // on a term from the real profile made this test pass or fail depending on whose machine
  // it ran on, and it is the explanation mechanism under test here, not anyone's stack.
  const fixture = {
    ...profile,
    stack: {
      core: [{ term: "node", weight: 8 }],
      domain: [{ term: "webhook", weight: 9 }],
      ai: [],
    },
  };
  const fixtureCtx = { ...ctx, profile: fixture };
  const j = hardFilter([job({ description: "Payment webhooks and idempotent ledger writes in Node.js." })], fixtureCtx).kept;
  const [scored] = prescoreAll(j, fixtureCtx);
  assert.ok(scored.prescoreHits.domain.includes("webhook"));
  assert.ok(scored.prescoreHits.stack.includes("node"));
  assert.ok(scored.prescore > 0);
});

test("company tier boosts a target-tier employer over a broad-tier one", () => {
  const target = job({ company: "Target Co", tier: "target", url: "https://example.com/a" });
  const broad = job({ company: "Broad Co", tier: "broad", url: "https://example.com/b" });
  const ranked = prescoreAll(hardFilter([broad, target], ctx).kept, ctx);
  assert.equal(ranked[0].company, "Target Co");
});

test("a city-only role whose posting never mentions remote is dropped", () => {
  const onsite = job({ title: "Backend Engineer", location: "Berlin", description: "Join us in our Berlin office." });
  assert.deepEqual(keptTitles([onsite]), []);
});

test("a city-only role that describes remote work is kept", () => {
  // 17 of 46 city-located rows turned out to be remote once the body was read.
  const remote = job({
    title: "Backend Engineer",
    location: "London",
    description: "We are a remote-first company; this role can work remotely from anywhere in EMEA.",
  });
  assert.deepEqual(keptTitles([remote]), ["Backend Engineer"]);
});

test("hybrid is not treated as remote", () => {
  const hybrid = job({ title: "Backend Engineer", location: "Madrid", description: "Hybrid role, three days a week in our Madrid office." });
  assert.deepEqual(keptTitles([hybrid]), []);
});

test("an explicitly remote location still passes without reading the body", () => {
  assert.deepEqual(keptTitles([job({ location: "Remote", description: "" })]), ["Backend Engineer"]);
});

test("US-Remote spellings are rejected, not treated as remote", () => {
  for (const loc of ["US - Remote", "US-Remote", "us remote", "Remote (United States)"]) {
    assert.deepEqual(keptTitles([job({ location: loc })]), [], `${loc} should be rejected`);
  }
});

test("boilerplate remote wording does not rescue an onsite role", () => {
  // Big-company postings mention remote in passing; that is not a remote job.
  const sf = job({
    location: "San Francisco, California",
    description: "We support remote work arrangements for some teams. This role is based in our SF office.",
  });
  assert.deepEqual(keptTitles([sf]), []);
});

test("an explicit fully-remote statement still rescues a city-located role", () => {
  const london = job({ location: "London", description: "This role is fully remote; work from anywhere in EMEA." });
  assert.deepEqual(keptTitles([london]), ["Backend Engineer"]);
});

test("a 'Remote' role whose hire-country list excludes Nigeria is rejected", () => {
  // Wikimedia: location says Remote, the body lists Ghana, Kenya, Morocco, South Africa.
  const j = job({
    location: "Remote",
    description: "We are currently able to hire in the following Countries: Brazil, Canada, Germany, Ghana, India, Kenya, Morocco, South Africa, Spain and the United Kingdom.",
  });
  assert.deepEqual(keptTitles([j]), []);
});

test("a hire-country list that includes Nigeria still passes", () => {
  const j = job({
    location: "Remote",
    description: "We are able to hire in the following countries: Kenya, Morocco, Nigeria, Poland and Estonia.",
  });
  assert.deepEqual(keptTitles([j]), ["Backend Engineer"]);
});
