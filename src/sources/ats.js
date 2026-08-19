import { getJSON, toText } from "../util.js";

/**
 * Per-company ATS boards. These are public job-board APIs, not global search —
 * coverage is exactly the company watchlist in config/companies.json.
 */

/**
 * The freshest date a board gives for a posting.
 *
 * Greenhouse reports both when a requisition was first opened and when it was
 * last touched, and for a company that hires continuously those are years
 * apart. Moniepoint's Senior Fullstack Engineer was first published in July
 * 2024 and updated yesterday; reading only the first date aged it at 764 days
 * and the freshness gate threw it away. Fifty-two of their hundred and twenty
 * roles were in that state, and they are the largest merchant acquirer in the
 * country he lives in.
 *
 * "How old is this posting" is really "when was it last confirmed live", so
 * take whichever date is later.
 */
function freshest(...dates) {
  const times = dates
    .filter(Boolean)
    .map((d) => new Date(d))
    .filter((d) => !Number.isNaN(d.getTime()));
  if (!times.length) return null;
  return new Date(Math.max(...times.map((d) => d.getTime()))).toISOString();
}

async function greenhouse({ slug, name }) {
  const data = await getJSON(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
  return (data.jobs || []).map((j) => ({
    sourceId: String(j.id),
    company: j.company_name || name,
    title: j.title,
    location: j.location?.name || "",
    url: j.absolute_url,
    postedAt: freshest(j.updated_at, j.first_published),
    description: toText(j.content),
    salaryText: "",
    tags: (j.departments || []).map((d) => d.name),
  }));
}

async function lever({ slug, name }) {
  const data = await getJSON(`https://api.lever.co/v0/postings/${slug}?mode=json`);
  return (Array.isArray(data) ? data : []).map((j) => ({
    sourceId: String(j.id),
    company: name,
    title: j.text,
    location: j.categories?.location || j.country || "",
    url: j.hostedUrl,
    postedAt: freshest(j.updatedAt, j.createdAt),
    description: [j.descriptionPlain, j.additionalPlain].filter(Boolean).join("\n\n"),
    salaryText: "",
    tags: [j.categories?.department, j.categories?.team, j.categories?.commitment].filter(Boolean),
  }));
}

async function ashby({ slug, name }) {
  const data = await getJSON(`https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`);
  return (data.jobs || []).map((j) => ({
    sourceId: String(j.id),
    company: name,
    title: j.title,
    location: [j.location, ...(j.secondaryLocations || []).map((l) => l.location)].filter(Boolean).join(", "),
    url: j.jobUrl || j.applyUrl,
    postedAt: freshest(j.updatedAt, j.publishedAt),
    description: j.descriptionPlain || toText(j.descriptionHtml),
    salaryText: j.compensation?.compensationTierSummary || "",
    tags: [j.department, j.team, j.employmentType, j.isRemote ? "remote" : ""].filter(Boolean),
    // `isRemote` lies. Notion publishes isRemote:true with workplaceType:"Hybrid" and
    // a San Francisco location — trusting the flag put SF office roles in a remote-only
    // digest. workplaceType is the field the board actually maintains, so it wins.
    remoteHint:
      j.workplaceType === "Remote" ? true
      : j.workplaceType ? false
      : j.isRemote === true ? true
      : j.isRemote === false ? false
      : null,
  }));
}

const ADAPTERS = { greenhouse, lever, ashby };

export async function fetchATS(boards, log = () => {}) {
  const out = [];
  const results = await Promise.allSettled(
    boards.map(async (b) => {
      const fn = ADAPTERS[b.ats];
      if (!fn) throw new Error(`unknown ats "${b.ats}"`);
      const jobs = await fn(b);
      return jobs.map((j) => ({ ...j, source: `${b.ats}:${b.slug}`, tier: b.tier, stage: b.stage, companyTags: b.tags || [] }));
    })
  );
  results.forEach((r, i) => {
    const b = boards[i];
    if (r.status === "fulfilled") {
      out.push(...r.value);
      log(`  ${b.ats}/${b.slug}`.padEnd(30) + `${r.value.length} jobs`);
    } else {
      log(`  ${b.ats}/${b.slug}`.padEnd(30) + `SKIPPED (${r.reason.message})`);
    }
  });
  return out;
}
