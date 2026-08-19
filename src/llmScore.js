import { SCORE_FIELDS, validateScore } from "./providers/schema.js";
import { fitToBudget } from "./util.js";

/**
 * Stage 3b: rubric scoring. Rationed — only the top N survivors of the prescore
 * reach this. The provider is injected, so switching between a free tier and a
 * paid model is configuration, not a code change.
 */

export function systemPrompt(profile) {
  return `You score job vacancies for one specific engineer. You are a hiring filter, not a cheerleader — a score that flatters him wastes his time.

CANDIDATE
${profile.summary}

Based in ${profile.location.city}, ${profile.location.country} (UTC+${profile.location.utcOffset}). ${profile.workAuth.note}
Needs visa sponsorship for: ${profile.workAuth.needsSponsorshipFor.join(", ")}.

WHAT HE HAS ACTUALLY SHIPPED
${profile.evidence.map((e) => `- ${e}`).join("\n")}

TECHNOLOGIES HE HAS NEVER USED
${(profile.neverClaim?.terms || []).map((t) => `- ${t.term}: ${t.truth}`).join("\n")}
A posting that names one of these is naming a gap, not a match. The pull to read a
stack out of a job description and credit it back to the candidate is strong: a
TypeScript-native role scored 82 with the justification "strong TypeScript grounding"
for a man who has never written a line of it. Judge him on the evidence above and
nothing else.

WANTS
${profile.preferences.wants.map((w) => `- ${w}`).join("\n")}

AVOIDS
${profile.preferences.avoids.map((w) => `- ${w}`).join("\n")}

SCORING
Sum the five components into "score" (max 100). Apply these hard rules:
- If the role is country-locked to a place he needs sponsorship for, location_fit is 0-4 and the total cannot exceed 45. This is the most common reason a technically perfect role is useless to him.
- If it is staff, principal, or people management, seniority_fit is 0-5.
- A role that is mostly frontend, or mostly coordination, cannot exceed 60 however good the company is.
- Do not inflate for a famous company. A generic role at a well-known name scores lower than a payments role at an unknown one.
- "against" must name the strongest real objection. If the description is vague about what he would actually build, say that.

TWO SEPARATE JUDGEMENTS — do not let one contaminate the other:
- 'score' is how much HE would want this role.
- 'odds' is how likely THEY are to hire him.
These regularly disagree, and that disagreement is the most useful thing you produce. A weekend support role he would dislike but clearly qualifies for should score low and have high odds. A dream payments role at a company that cannot employ in Nigeria should score high and have odds near zero.

For 'odds', weigh in this order:
1. Can they legally employ him in Nigeria? A country list that omits Nigeria caps odds at 10 however well he matches. This kills more good applications than anything else.
2. How many stated REQUIRED items does he actually meet? Adjacent experience is not a match. If a technology from the never-used list is a stated REQUIRED item, it is a missing requirement — and if the role is built around it, odds cannot exceed 15 however well the rest fits.
3. Is the seniority band right? Staff and above, or people management, caps odds at 20.
4. How competitive is the role? A generic remote backend post at a famous company draws thousands; a niche payments role at an unknown one draws far fewer.

Return only the structured fields. No preamble.`;
}

export function userPrompt(job) {
  return `COMPANY: ${job.company}
TITLE: ${job.title}
LOCATION: ${job.location || "(not stated)"}
POSTED: ${job.ageDays === null ? "unknown" : `${job.ageDays} days ago`}
COMPENSATION: ${job.salaryText || "(not stated)"}
TAGS: ${(job.tags || []).slice(0, 12).join(", ") || "(none)"}

DESCRIPTION
${fitToBudget(job.description, 30000) || "(no description provided)"}`;
}

export async function scoreWithLLM(jobs, { profile, provider, onProgress = () => {} }) {
  const system = systemPrompt(profile);
  const out = [];
  let done = 0;
  const usage = { input: 0, output: 0, calls: 0, failed: 0, firstError: null };

  const queue = [...jobs];
  const workers = Array.from({ length: Math.min(provider.concurrency ?? 3, queue.length) }, async () => {
    while (queue.length) {
      const job = queue.shift();
      try {
        const { data, usage: u } = await provider.complete(system, userPrompt(job), SCORE_FIELDS);
        const verdict = validateScore(data);
        usage.input += u.input;
        usage.output += u.output;
        usage.calls += 1;
        out.push({ ...job, ...verdict, scoredBy: `${provider.name}:${provider.model}`, scoredAt: new Date().toISOString() });
      } catch (err) {
        usage.failed += 1;
        // Surface the first failure. Counting failures without saying why is how a
        // broken scoring stage hides behind a plausible-looking empty shortlist.
        if (!usage.firstError) {
          const m = /"message"\s*:\s*"([^"]+)"/.exec(err.message);
          usage.firstError = (m ? m[1] : err.message).slice(0, 200);
        }
        // A failed call must not lose the job — it falls through to the prescore.
        out.push({ ...job, score: null, scoreError: err.message, reason: "", against: "" });
        if (usage.failed >= 3 && usage.calls === 0) queue.length = 0; // fail fast on a systemic error
      }
      onProgress(++done, jobs.length);
    }
  });

  await Promise.all(workers);
  return { scored: out.sort((a, b) => (b.score ?? -1) - (a.score ?? -1)), usage };
}
