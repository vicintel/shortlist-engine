import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLinkedInAlert, extractHtml, canonicalJobUrl, fetchGmailAlerts } from "../src/sources/gmail.js";

const card = (id, title, company, location) => `
  <table><tr><td>
    <a href="https://www.linkedin.com/comm/jobs/view/${id}/?trackingId=abc%3D%3D&refId=xyz">${title}</a>
    <p>${company} &middot; ${location}</p>
    <a href="https://www.linkedin.com/comm/jobs/view/${id}/apply">Apply now</a>
  </td></tr></table>`;

const alertEmail = (...cards) => `<html><body><h2>Your job alert</h2>${cards.join("")}</body></html>`;

test("canonicalJobUrl strips tracking down to the public posting", () => {
  assert.equal(
    canonicalJobUrl("https://www.linkedin.com/comm/jobs/view/4123456789/?trackingId=x%3D&refId=y"),
    "https://www.linkedin.com/jobs/view/4123456789/"
  );
  assert.equal(canonicalJobUrl("https://www.linkedin.com/feed/"), null);
});

test("a job card yields title, company and location", () => {
  const jobs = parseLinkedInAlert(alertEmail(card("4111", "Senior Backend Engineer", "Paystack", "Lagos (Remote)")));
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].title, "Senior Backend Engineer");
  assert.equal(jobs[0].company, "Paystack");
  assert.match(jobs[0].location, /Lagos/);
  assert.equal(jobs[0].url, "https://www.linkedin.com/jobs/view/4111/");
  assert.equal(jobs[0].remoteHint, true);
});

test("the Apply button on the same card is not mistaken for a second job", () => {
  const jobs = parseLinkedInAlert(alertEmail(card("4111", "Backend Engineer", "Acme", "Remote")));
  assert.equal(jobs.length, 1);
});

test("the same vacancy across several alerts collapses to one row", () => {
  const html = alertEmail(
    card("4111", "Backend Engineer", "Acme", "Remote"),
    card("4222", "Platform Engineer", "Beta", "Berlin"),
    card("4111", "Backend Engineer", "Acme", "Remote")
  );
  const jobs = parseLinkedInAlert(html);
  assert.equal(jobs.length, 2);
});

test("a card body cut mid-tag does not leak markup into the fields", () => {
  // The read window is a fixed slice, so it routinely ends inside a tag.
  const html = `<a href="https://www.linkedin.com/comm/jobs/view/4777/">Backend Engineer</a>
    <p>Moniepoint &middot; Lagos, Nigeria</p><table cellpadding=`;
  const [job] = parseLinkedInAlert(html);
  assert.equal(job.company, "Moniepoint");
  assert.equal(job.location, "Lagos, Nigeria");
  assert.doesNotMatch(job.location, /<|table|cellpadding/);
});

test("a card with no readable title is dropped, not guessed at", () => {
  const jobs = parseLinkedInAlert(`<a href="https://www.linkedin.com/comm/jobs/view/4333/"><img src="x"></a>`);
  assert.equal(jobs.length, 0);
});

test("quoted-printable HTML is decoded before parsing", () => {
  // LinkedIn encodes every '=' as '=3D' and wraps long lines with a trailing '='.
  const raw = [
    "Content-Type: multipart/alternative; boundary=--abc123",
    "",
    "----abc123",
    "Content-Type: text/plain",
    "",
    "plain text version",
    "----abc123",
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    '<a href=3D"https://www.linkedin.com/comm/jobs/view/4444/?trackingId=3Dz">Sta=',
    "ff Engineer</a><p>Monzo &middot; London</p>",
    "----abc123--",
  ].join("\r\n");

  const html = extractHtml(raw);
  assert.match(html, /href="https/);
  const jobs = parseLinkedInAlert(html);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].title, "Staff Engineer");
  assert.equal(jobs[0].company, "Monzo");
});

test("base64 parts are decoded too", () => {
  const inner = `<a href="https://www.linkedin.com/comm/jobs/view/4555/">Data Engineer</a><p>Grey · Remote</p>`;
  const raw = [
    "Content-Type: multipart/alternative; boundary=--b",
    "",
    "----b",
    "Content-Type: text/html",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(inner).toString("base64"),
    "----b--",
  ].join("\r\n");
  const jobs = parseLinkedInAlert(extractHtml(raw));
  assert.equal(jobs[0].title, "Data Engineer");
});

test("missing credentials skip the source instead of throwing", async () => {
  const lines = [];
  const jobs = await fetchGmailAlerts({ env: {}, log: (l) => lines.push(l) });
  assert.deepEqual(jobs, []);
  assert.match(lines.join(" "), /SKIPPED/);
});

test("an IMAP failure skips the source instead of killing the run", async () => {
  const lines = [];
  const clientFactory = () => ({
    connect: async () => { throw new Error("invalid credentials"); },
    logout: async () => {},
  });
  const jobs = await fetchGmailAlerts({
    env: { GMAIL_USER: "a@b.c", GMAIL_APP_PASSWORD: "x" },
    clientFactory,
    log: (l) => lines.push(l),
  });
  assert.deepEqual(jobs, []);
  assert.match(lines.join(" "), /invalid credentials/);
});

test("the mailbox is opened read-only", async () => {
  let opts = null;
  const clientFactory = () => ({
    connect: async () => {},
    getMailboxLock: async (_box, o) => { opts = o; return { release() {} }; },
    search: async () => [],
    fetch: async function* () {},
    logout: async () => {},
  });
  await fetchGmailAlerts({ env: { GMAIL_USER: "a@b.c", GMAIL_APP_PASSWORD: "x" }, clientFactory });
  assert.equal(opts.readOnly, true);
});

test("jobs inherit the alert email's date so the freshness gate can work", () => {
  const sent = "2026-08-01T06:00:00.000Z";
  const [job] = parseLinkedInAlert(
    `<a href="https://www.linkedin.com/comm/jobs/view/4888/">Backend Engineer</a><p>Acme · Remote</p>`,
    sent
  );
  assert.equal(job.postedAt, sent);
});

test("with no email date the job is still returned, dateless", () => {
  const [job] = parseLinkedInAlert(
    `<a href="https://www.linkedin.com/comm/jobs/view/4889/">Backend Engineer</a><p>Acme · Remote</p>`
  );
  assert.equal(job.postedAt, null);
});
