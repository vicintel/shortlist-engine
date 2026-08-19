import { norm, daysAgo } from "./util.js";

/**
 * Stage 2: deterministic elimination. Everything here is free, so it runs on the
 * full corpus and decides what the paid stage never sees. Rejections are counted
 * by reason so `stats` can show whether a rule is over-firing.
 */
export function hardFilter(jobs, { profile, rules }) {
  const reasons = {};
  const kept = [];
  const bump = (r) => { reasons[r] = (reasons[r] || 0) + 1; };

  const rejectTitles = profile.seniority.rejectTitles.map(norm);
  const dealbreakers = rules.dealbreakers.phrases.map(norm);
  const gateIn = rules.titleGate.mustContainAny.map(norm);
  const gateOut = rules.titleGate.rejectContainsAny.map(norm);
  const {
    eligible, ineligible, onsiteAllowed, globalTokens, lockedCountries,
    remoteOnly = false, remoteSignals = [],
  } = rules.locationRules;

  /** Remote-but-country-locked: "Remote - India" is remote and still unusable from Lagos. */
  const countryLocked = (loc) => {
    if (globalTokens.some((t) => loc.includes(norm(t)))) return false;
    return lockedCountries.some((c) => loc.includes(norm(c)));
  };

  for (const job of jobs) {
    if (!job.title || !job.url || !job.company) { bump("incomplete record"); continue; }

    const age = daysAgo(job.postedAt);
    if (age !== null && age > rules.freshnessDays) { bump(`older than ${rules.freshnessDays} days`); continue; }

    const title = norm(job.title);
    if (rejectTitles.some((t) => title.includes(t))) { bump("title out of scope"); continue; }

    // Seniority bands read as a leading word ("Staff Core Platform Engineer"), so a
    // contiguous-substring check against "staff engineer" misses them.
    if (/^(staff|principal|distinguished|fellow|director|head|chief|vp|lead)\b/.test(title)) {
      bump("above target seniority band"); continue;
    }

    const badWord = gateOut.find((t) => title.includes(t));
    if (badWord) { bump(`non-engineering title: ${badWord}`); continue; }
    if (!gateIn.some((t) => title.includes(t))) { bump("title is not an engineering role"); continue; }

    const haystack = norm(`${job.title} ${job.description}`);
    const hit = dealbreakers.find((p) => haystack.includes(p));
    if (hit) { bump(`dealbreaker: ${hit}`); continue; }

    // A posting that says "Remote" in the location field and then lists the countries it
    // can actually hire in — Wikimedia lists Ghana, Kenya, Morocco and South Africa, but
    // not Nigeria. The location string alone never reveals this.
    const desc = norm(job.description);
    const hireList = desc.match(/(?:able to hire in|can only hire in|hire in the following|eligible to work in one of)[^.]{0,600}/);
    if (hireList && !onsiteAllowed.some((c) => hireList[0].includes(c))) {
      bump("hires only in listed countries, not yours");
      continue;
    }

    const loc = norm(job.location);
    const onsiteOk = onsiteAllowed.some((c) => loc.includes(c));
    if (!onsiteOk && ineligible.some((p) => loc.includes(norm(p)))) { bump("location ineligible"); continue; }
    if (!onsiteOk && countryLocked(loc)) { bump("remote but country-locked"); continue; }

    let locationFit = onsiteOk ? "eligible"
      : eligible.some((p) => loc.includes(norm(p))) || job.remoteHint === true ? "eligible"
      : "unclear";

    // A location that names only a city says nothing on its own: 17 of 46 such rows
    // turned out to describe remote work in the body. So read the posting before
    // dropping it — dropping on the location string alone loses real remote jobs,
    // and keeping everything fills the digest with roles that need a move to Berlin.
    if (locationFit === "unclear" && remoteOnly) {
      const haystack = norm(`${job.title} ${job.location} ${(job.tags || []).join(" ")} ${job.description}`);
      if (!remoteSignals.some((p) => haystack.includes(norm(p)))) {
        bump("onsite role — nothing in the posting mentions remote");
        continue;
      }
      locationFit = "eligible";
    }

    kept.push({ ...job, ageDays: age, locationFit });
  }

  return { kept, reasons };
}
