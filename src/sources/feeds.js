import { getJSON, toText } from "../util.js";

/**
 * Global aggregator feeds. Unlike ATS boards these are not company-scoped, so they
 * widen coverage beyond the watchlist — at the cost of noisier, lower-signal listings.
 */

async function remoteok() {
  const data = await getJSON("https://remoteok.com/api");
  // First element is a legal/attribution notice, not a job.
  return (Array.isArray(data) ? data.slice(1) : []).map((j) => ({
    sourceId: String(j.id || j.slug),
    company: j.company,
    title: j.position,
    location: j.location || "Remote",
    url: j.url || j.apply_url,
    postedAt: j.date || (j.epoch ? new Date(j.epoch * 1000).toISOString() : null),
    description: toText(j.description),
    salaryText: j.salary_min && j.salary_max ? `$${j.salary_min}–$${j.salary_max}` : "",
    tags: j.tags || [],
    remoteHint: true,
  }));
}

async function remotive() {
  const data = await getJSON("https://remotive.com/api/remote-jobs?category=software-dev");
  return (data.jobs || []).map((j) => ({
    sourceId: String(j.id),
    company: j.company_name,
    title: j.title,
    location: j.candidate_required_location || "Remote",
    url: j.url,
    postedAt: j.publication_date || null,
    description: toText(j.description),
    salaryText: j.salary || "",
    tags: [...(j.tags || []), j.job_type].filter(Boolean),
    remoteHint: true,
  }));
}

async function arbeitnow() {
  const data = await getJSON("https://www.arbeitnow.com/api/job-board-api");
  return (data.data || []).map((j) => ({
    sourceId: String(j.slug),
    company: j.company_name,
    title: j.title,
    location: j.location || (j.remote ? "Remote" : ""),
    url: j.url,
    postedAt: j.created_at ? new Date(j.created_at * 1000).toISOString() : null,
    description: toText(j.description),
    salaryText: "",
    tags: [...(j.tags || []), ...(j.job_types || [])].filter(Boolean),
    remoteHint: j.remote === true ? true : null,
  }));
}

async function himalayas() {
  const data = await getJSON("https://himalayas.app/jobs/api?limit=100");
  return (data.jobs || []).map((j) => ({
    sourceId: String(j.guid),
    company: j.companyName,
    title: j.title,
    location: (j.locationRestrictions || []).join(", ") || "Remote (worldwide)",
    // No company-page fallback. A row that links to /companies/<slug> is not a
    // posting, and it occupies a digest slot that a real vacancy could have had.
    url: j.applicationLink || "",
    postedAt: j.pubDate ? new Date(j.pubDate * 1000).toISOString() : null,
    description: toText(j.description || j.excerpt),
    salaryText: j.minSalary && j.maxSalary ? `${j.currency || ""}${j.minSalary}–${j.maxSalary}/${j.salaryPeriod || "year"}` : "",
    tags: [...(j.categories || []), j.employmentType, j.seniority].filter(Boolean),
    remoteHint: true,
  }));
}

const FEEDS = { remoteok, remotive, arbeitnow, himalayas };

/**
 * A row whose URL is a bare domain is a company homepage, not a vacancy — Arbeitnow
 * emits these (`https://www.preiswecker.com/`) and one reached a digest. Dropping them
 * here is cheaper than letting VERIFY spend a request discovering it later.
 */
export function hasPostingUrl(job) {
  if (!job.url || !/^https?:\/\//i.test(job.url)) return false;
  try {
    return new URL(job.url).pathname.replace(/\/+$/, "") !== "";
  } catch {
    return false;
  }
}

export async function fetchFeeds(enabled, log = () => {}) {
  const names = enabled || Object.keys(FEEDS);
  const out = [];
  const results = await Promise.allSettled(names.map((n) => FEEDS[n]()));
  results.forEach((r, i) => {
    const name = names[i];
    if (r.status === "fulfilled") {
      const usable = r.value.filter(hasPostingUrl);
      const dropped = r.value.length - usable.length;
      out.push(...usable.map((j) => ({ ...j, source: name, tier: "feed", companyTags: [] })));
      log(`  ${name}`.padEnd(30) + `${usable.length} jobs` + (dropped ? ` (${dropped} without a posting link)` : ""));
    } else {
      log(`  ${name}`.padEnd(30) + `SKIPPED (${r.reason.message})`);
    }
  });
  return out;
}
