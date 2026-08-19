import { norm, clamp } from "./util.js";

/**
 * Stage 3a: free lexical scoring. Its only job is to rank the survivors so the
 * paid stage spends its budget on the most plausible ones. It is deliberately
 * crude — it decides who gets read, not who gets shortlisted.
 */
export function prescore(job, { profile, rules, companies }) {
  const cfg = rules.prescore;
  const title = norm(job.title);
  const body = norm(`${job.title}\n${job.description}`);
  const hits = { stack: [], domain: [], ai: [] };

  const tally = (terms, cap, bucket) => {
    let sum = 0;
    for (const { term, weight } of terms) {
      if (body.includes(term)) { sum += weight; hits[bucket].push(term); }
    }
    return clamp(sum, 0, cap);
  };

  let score = 0;
  const parts = {};

  parts.stack = tally(profile.stack.core, cfg.maxStackPoints, "stack");
  parts.domain = tally(profile.stack.domain, cfg.maxDomainPoints, "domain");
  parts.ai = tally(profile.stack.ai, cfg.maxAiPoints, "ai");
  score += parts.stack + parts.domain + parts.ai;

  const titleMatch = profile.seniority.acceptTitles.some((t) => title.includes(norm(t)));
  parts.title = titleMatch ? cfg.titleMatchBonus : 0;
  score += parts.title;

  parts.tier = companies.tierBoost[job.tier] ?? 0;
  score += parts.tier;

  // Company size matters as much as domain here. A startup needs someone to own a
  // system end to end, which is exactly what he did solo; a large company wants a
  // specialist for one slice of it.
  parts.stage = (companies.stageBoost || {})[job.stage] ?? 0;
  score += parts.stage;

  parts.freshness = job.ageDays !== null && job.ageDays <= cfg.freshnessBonusDays ? cfg.freshnessBonus : 0;
  score += parts.freshness;

  parts.location = job.locationFit === "eligible" ? 5 : 0;
  score += parts.location;

  return { ...job, prescore: Math.round(score), prescoreParts: parts, prescoreHits: hits };
}

export function prescoreAll(jobs, ctx) {
  return jobs.map((j) => prescore(j, ctx)).sort((a, b) => b.prescore - a.prescore);
}
