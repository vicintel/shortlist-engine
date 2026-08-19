/**
 * Confirm a posting's link actually shows that job before it reaches the digest.
 *
 * Status codes are not enough. Ashby serves its board shell with HTTP 200 for a
 * posting it cannot resolve — PostHog's board returns `"organization": null` for
 * every URL, including URLs its own posting API hands out, because they run the
 * API but leave the hosted board dark. Aggregator feeds are worse: some rows carry
 * nothing but a company homepage.
 *
 * Fail OPEN. A timeout, a DNS blip or a 429 marks nothing dead — a flaky connection
 * must never silently empty the digest. Only a definite negative closes a job.
 */

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** Phrases that only appear once a posting is gone. Kept narrow on purpose. */
const CLOSED_PHRASES = [
  "no longer accepting applications",
  "this job is no longer available",
  "this position is no longer available",
  "position has been filled",
  "this posting is no longer active",
  "job posting not found",
];

/** Never match a bare "404": it collides with SVG path data such as `13.3404`. */
const DEAD_TITLES = ["404", "not found", "page unavailable", "job not found"];

const titleOf = (html) => (html.match(/<title[^>]*>([^<]*)/i)?.[1] || "").trim();
const words = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
const pathOf = (u) => { try { return new URL(u).pathname.replace(/\/+$/, ""); } catch { return ""; } };

/** Ashby renders client-side; the server's verdict is in the bootstrap payload. */
export function ashbyVerdict(html) {
  const m = html.match(/window\.__appData\s*=\s*(\{.*?\});/s);
  if (!m) return null;
  try {
    const data = JSON.parse(m[1]);
    if (data.organization === null && data.posting === null) return "board did not resolve this posting";
    return null;
  } catch {
    return null;
  }
}

/** Does the page still name this job? Catches redirects to a careers homepage. */
export function mentionsJob(title, html) {
  const distinctive = words(title).filter((w) => w.length > 3);
  if (!distinctive.length) return true;
  const body = words(html).join(" ");
  const hits = distinctive.filter((w) => body.includes(w)).length;
  return hits / distinctive.length >= 0.6;
}

/**
 * @returns {"live"|"dead"|"unknown"} plus a human reason for anything not live.
 */
export async function verifyOne(job, { fetchImpl = fetch, timeout = 20000 } = {}) {
  if (!job.url || !/^https?:\/\//.test(job.url)) return { state: "dead", reason: "no url" };

  // A bare domain is a company homepage, not a posting. Some feeds emit these.
  if (!pathOf(job.url)) return { state: "dead", reason: "url is a bare domain, not a posting" };

  let res, html;
  try {
    res = await fetchImpl(job.url, {
      redirect: "follow",
      headers: { "user-agent": UA, accept: "text/html,*/*" },
      signal: AbortSignal.timeout(timeout),
    });
    html = await res.text();
  } catch (err) {
    return { state: "unknown", reason: err.name === "TimeoutError" ? "timeout" : err.message };
  }

  // 5xx and 429 are the server having a bad day, not a closed job. 403 and LinkedIn's
  // non-standard 999 mean "we don't serve robots" — that says nothing about the vacancy.
  if (res.status >= 500 || res.status === 429 || res.status === 403 || res.status === 999)
    return { state: "unknown", reason: `HTTP ${res.status} (blocked, not closed)` };
  if (!res.ok) return { state: "dead", reason: `HTTP ${res.status}` };

  const ashby = ashbyVerdict(html);
  if (ashby) return { state: "dead", reason: ashby };

  const title = titleOf(html).toLowerCase();
  const badTitle = DEAD_TITLES.find((t) => title.includes(t));
  if (badTitle) return { state: "dead", reason: `page title says "${titleOf(html)}"` };

  const phrase = CLOSED_PHRASES.find((p) => html.toLowerCase().includes(p));
  if (phrase) return { state: "dead", reason: `page says "${phrase}"` };

  if (!mentionsJob(job.title, html))
    return { state: "dead", reason: `page never mentions "${job.title}"` };

  return { state: "live", reason: "" };
}

/** Verify a batch with bounded concurrency. Order of the returned array is preserved. */
export async function verifyAll(jobs, { concurrency = 6, ...opts } = {}) {
  const out = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      out[i] = { job: jobs[i], ...(await verifyOne(jobs[i], opts)) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return out;
}
