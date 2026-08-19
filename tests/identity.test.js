import { test } from "node:test";
import assert from "node:assert/strict";
import { jobHash, toText, norm, daysAgo, rateLimiter } from "../src/util.js";

test("the same role from two sources collapses to one identity", () => {
  const fromATS = { company: "PostHog", title: "Backend Engineer", location: "Remote" };
  const fromFeed = { company: "posthog", title: "Backend  Engineer", location: "Remote" };
  assert.equal(jobHash(fromATS), jobHash(fromFeed));
});

test("identity ignores the source, so an ATS posting and its mirror match", () => {
  const a = { company: "Supabase", title: "SDK Engineer", location: "Remote", source: "ashby:supabase" };
  const b = { company: "Supabase", title: "SDK Engineer", location: "Remote", source: "remoteok" };
  assert.equal(jobHash(a), jobHash(b));
});

test("different roles at the same company stay distinct", () => {
  const a = jobHash({ company: "PostHog", title: "Backend Engineer", location: "Remote" });
  const b = jobHash({ company: "PostHog", title: "Context Engineer", location: "Remote" });
  assert.notEqual(a, b);
});

test("location is compared on its leading segment only", () => {
  // "Remote, Poland" and "Remote (Poland)" are the same posting listed two ways.
  const a = jobHash({ company: "X", title: "Engineer", location: "Remote, Poland" });
  const b = jobHash({ company: "X", title: "Engineer", location: "Remote (Poland)" });
  assert.equal(a, b);
});

test("punctuation in a title does not fork the identity", () => {
  const a = jobHash({ company: "X", title: "Full-Stack Engineer", location: "Remote" });
  const b = jobHash({ company: "X", title: "Full Stack Engineer", location: "Remote" });
  assert.equal(a, b);
});

test("toText decodes entities and strips markup", () => {
  const html = "<p>Node &amp; Express</p><ul><li>Webhooks</li></ul><script>evil()</script>";
  const out = toText(html);
  assert.match(out, /Node & Express/);
  assert.match(out, /• Webhooks/);
  assert.doesNotMatch(out, /evil|script|<|>/);
});

test("toText handles numeric and hex entities", () => {
  assert.match(toText("caf&#233; &#x2014; bar"), /café — bar/);
});

test("norm collapses whitespace and case", () => {
  assert.equal(norm("  Senior   BACKEND\nEngineer "), "senior backend engineer");
});

test("daysAgo returns null for a missing or unparseable date", () => {
  assert.equal(daysAgo(null), null);
  assert.equal(daysAgo("not a date"), null);
  assert.equal(daysAgo(new Date().toISOString()), 0);
});

test("rateLimiter spaces calls by the configured interval", async () => {
  const throttle = rateLimiter(600); // 100ms apart
  const t0 = Date.now();
  await throttle(); await throttle(); await throttle();
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 190, `expected >=190ms of spacing, got ${elapsed}ms`);
});

test("rateLimiter with rpm 0 does not block", async () => {
  const throttle = rateLimiter(0);
  const t0 = Date.now();
  await throttle(); await throttle();
  assert.ok(Date.now() - t0 < 50);
});
