import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyOne, verifyAll, ashbyVerdict, mentionsJob } from "../src/verify.js";

const job = (over = {}) => ({
  id: "abc123",
  company: "Acme",
  title: "Backend Engineer",
  url: "https://example.com/jobs/1",
  ...over,
});

/** Minimal stand-in for fetch. */
const reply = ({ status = 200, body = "", url } = {}) => async (requested) => ({
  ok: status >= 200 && status < 300,
  status,
  url: url || requested,
  text: async () => body,
});

const page = (title, body = "") => `<html><head><title>${title}</title></head><body>${body}</body></html>`;

test("a page that still names the job is live", async () => {
  const html = page("Backend Engineer @ Acme", "We are hiring a Backend Engineer.");
  const r = await verifyOne(job(), { fetchImpl: reply({ body: html }) });
  assert.equal(r.state, "live");
});

test("an Ashby shell that resolved nothing is dead, despite HTTP 200", async () => {
  // The PostHog failure: their posting API hands out jobs.ashbyhq.com URLs that
  // their own hosted board cannot resolve.
  const html = page(
    "Jobs",
    `<script>window.__appData = {"environment":"production","organization":null,"posting":null,"jobBoard":null};</script>`
  );
  const r = await verifyOne(job({ url: "https://jobs.ashbyhq.com/posthog/1803b1de" }), {
    fetchImpl: reply({ body: html }),
  });
  assert.equal(r.state, "dead");
  assert.match(r.reason, /did not resolve/);
});

test("an Ashby page that did resolve is live", async () => {
  const html = page(
    "Backend Engineer @ Acme",
    `<script>window.__appData = {"organization":{"name":"Acme"},"posting":{"id":"1"}};</script>
     <h1>Backend Engineer</h1>`
  );
  const r = await verifyOne(job({ url: "https://jobs.ashbyhq.com/acme/1" }), { fetchImpl: reply({ body: html }) });
  assert.equal(r.state, "live");
});

test("SVG path data containing 404 does not kill a live page", async () => {
  // `13.3404` inside a path once marked six live Greenhouse jobs dead.
  const html = page(
    "Job Application for Backend Engineer at Acme",
    `<svg><path d="M18.9925 5.27962 19.8168 13.3404 15.9936 18.5304Z"/></svg><h1>Backend Engineer</h1>`
  );
  const r = await verifyOne(job(), { fetchImpl: reply({ body: html }) });
  assert.equal(r.state, "live");
});

test("a 404 title is dead", async () => {
  const r = await verifyOne(job(), { fetchImpl: reply({ body: page("404 — Page Not Found") }) });
  assert.equal(r.state, "dead");
});

test("an explicit closure notice is dead", async () => {
  const html = page("Backend Engineer @ Acme", "This role is no longer accepting applications.");
  const r = await verifyOne(job(), { fetchImpl: reply({ body: html }) });
  assert.equal(r.state, "dead");
});

test("a page that never mentions the job is dead", async () => {
  // A closed posting that redirects to a generic careers page still returns 200
  // with a perfectly good title.
  const html = page("Careers at Acme", "Browse our open roles across sales and marketing.");
  const r = await verifyOne(job(), { fetchImpl: reply({ body: html }) });
  assert.equal(r.state, "dead");
  assert.match(r.reason, /never mentions/);
});

test("a bare domain is dead without a request", async () => {
  let called = false;
  const r = await verifyOne(job({ url: "https://www.preiswecker.com/" }), {
    fetchImpl: async () => { called = true; },
  });
  assert.equal(r.state, "dead");
  assert.equal(called, false);
});

test("a timeout is unknown, never dead", async () => {
  const boom = async () => { const e = new Error("timed out"); e.name = "TimeoutError"; throw e; };
  const r = await verifyOne(job(), { fetchImpl: boom });
  assert.equal(r.state, "unknown");
});

test("429 and 5xx are unknown, never dead", async () => {
  for (const status of [429, 500, 503]) {
    const r = await verifyOne(job(), { fetchImpl: reply({ status, body: "" }) });
    assert.equal(r.state, "unknown", `HTTP ${status} should be unknown`);
  }
});

test("404 is dead", async () => {
  const r = await verifyOne(job(), { fetchImpl: reply({ status: 404, body: page("Not Found") }) });
  assert.equal(r.state, "dead");
});

test("verifyAll preserves input order under concurrency", async () => {
  const jobs = Array.from({ length: 10 }, (_, i) => job({ id: `j${i}`, title: `Engineer ${i}` }));
  const fetchImpl = async (url) => {
    await new Promise((r) => setTimeout(r, Math.random() * 5));
    return { ok: true, status: 200, url, text: async () => page("x", "Engineer") };
  };
  const out = await verifyAll(jobs, { fetchImpl, concurrency: 4 });
  assert.deepEqual(out.map((r) => r.job.id), jobs.map((j) => j.id));
});

test("ashbyVerdict ignores a payload it cannot parse", () => {
  assert.equal(ashbyVerdict("<script>window.__appData = {not json};</script>"), null);
  assert.equal(ashbyVerdict("<html>no payload</html>"), null);
});

test("mentionsJob tolerates partial wording but not a different page", () => {
  assert.equal(mentionsJob("Senior Backend Engineer", "we want a backend engineer, senior level"), true);
  assert.equal(mentionsJob("Senior Backend Engineer", "sales development representative role"), false);
  assert.equal(mentionsJob("", "anything"), true);
});
