import fs from "node:fs";
import path from "node:path";
import { APPLY_FIELDS, validateApply } from "./providers/schema.js";
import { fitToBudget } from "./util.js";

/**
 * Produces an application kit for one role: a tailored cover letter, reordered CV
 * bullets, drafts for the questions the form will ask, honest gaps, and questions
 * to ask them.
 *
 * It does not submit anything. See README § Why there is no auto-apply.
 */

function systemPrompt(profile) {
  return `You prepare job application material for one specific engineer. Everything you write will be read and sent by him, so it must sound like a competent person wrote it in ten minutes — not like a template.

CANDIDATE
${profile.name} — ${profile.headline}
${profile.summary}

Based in ${profile.location.city}, ${profile.location.country} (UTC+${profile.location.utcOffset}).
Work authorisation: citizen of ${profile.workAuth.citizenOf.join(", ")}. Needs visa sponsorship for ${profile.workAuth.needsSponsorshipFor.join(", ")}. ${profile.workAuth.note}

VERIFIED EVIDENCE — the only things you may claim he has done
${profile.evidence.map((e, i) => `${i + 1}. ${e}`).join("\n")}

TECHNOLOGIES HE HAS NOT USED — never claim these, however prominently the posting names them. Naming the job's stack back at them is the fastest way to be caught, and it collapses in the first interview question.
${(profile.neverClaim?.terms || []).map((t) => `- ${t.term}: ${t.truth}`).join("\n")}
If the posting requires one of these, that is a "missing" row in the requirements audit and a line in "gaps". It is never a claim.

WHAT HE WANTS
${profile.preferences.wants.map((w) => `- ${w}`).join("\n")}

HARD RULES
- Never invent a system, a metric, a company, a technology or a year. If the posting wants something he has not done, that belongs in "gaps", not in the cover letter.
- Never claim work authorisation he does not have. If the role is in a country needing sponsorship, say plainly that he would need it — do not bury or fudge it.
- No "I am writing to apply for". No "passionate". No "I believe I would be a great fit". No restating their job description back at them.
- Prefer one specific thing he built over three vague claims. Numbers he actually has (117K lines, 7,800 commits, 43 round trips to 3, 1,852KB to 467KB, N4,120 vs N1,030) beat adjectives.
- British spelling. First person. Plain sentences.

BANNED — these are the standard tells of machine writing, and a reader who spots one stops reading the content and starts reading the source. Some employers screen for them explicitly.
- Never write "not only X but also Y", "it's not X, it's Y", or "rather than X, I Y" as a rhetorical opener. State what he did. If a contrast is genuinely factual ("the bottleneck was network latency, not query time") that is fine — the ban is on the flourish, not on comparison.
- Never use: robust, leverage, seamless, showcase, underscore, delve, crucial, pivotal, meticulous, testament, landscape, foster, garner, enhance, bolster, vibrant, intricate, tapestry, cutting-edge, groundbreaking, proven track record, ideal candidate, strong match, passionate, thrilled, excited to.
- Never dodge the verb "is" with "serves as", "stands as", "functions as", "positions him as". Never use "boasts" for "has".
- Do not tack a participle onto a sentence to add fake significance: no ", highlighting…", ", underscoring…", ", ensuring…", ", demonstrating…", ", showcasing…", ", reflecting…".
- At most one em dash in the whole letter. Prefer a full stop.
- Avoid three-item lists as a default rhythm. Two items, or four, or a plain sentence.
- Write the way he talks in a work message: short declarative sentences, concrete nouns, real numbers. If a sentence would survive being said out loud to a colleague, keep it. If it sounds like a brochure, cut it.
- If the posting is thin or vague, say so in "gaps" rather than padding the letter with invented enthusiasm.`;
}

function userPrompt(job) {
  return `Prepare the application material for this role.

COMPANY: ${job.company}
TITLE: ${job.title}
LOCATION: ${job.location || "(not stated)"}
COMPENSATION: ${job.salaryText || "(not stated)"}
POSTED: ${job.ageDays === null ? "unknown" : `${job.ageDays} days ago`}
URL: ${job.url}
${job.reason ? `\nPRIOR ASSESSMENT: ${job.reason}` : ""}${job.against ? `\nKNOWN OBJECTION: ${job.against}` : ""}

FULL POSTING
${fitToBudget(job.description, 30000) || "(no description provided)"}`;
}

/**
 * Scans what he would actually SEND for technologies he has never used. The prompt
 * already forbids them, and the model claimed Postgres and TypeScript four times
 * each anyway — a posting that names a stack is a strong pull. A false claim here
 * survives to an interview and collapses there, so this is a hard gate rather than
 * a warning.
 */
export function findFalseClaims(kit, profile) {
  const sendable = [
    kit.cover_letter,
    ...(kit.answers || []).map((a) => a.answer),
    ...(kit.cv_bullets || []).map((b) => b.bullet),
  ].join("\n").toLowerCase();

  return (profile.neverClaim?.terms || [])
    .filter(({ term }) => new RegExp(`\\b${term}\\b`, "i").test(sendable))
    .map(({ term, truth }) => ({ term, truth }));
}

export async function buildKit(job, { profile, provider }) {
  const { data, usage } = await provider.complete(
    systemPrompt(profile),
    userPrompt(job),
    APPLY_FIELDS,
    { maxTokens: 8000 }
  );
  const kit = validateApply(data);
  const falseClaims = findFalseClaims(kit, profile);
  return { kit, usage, falseClaims };
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40).replace(/^-|-$/g, "");

/**
 * Counted from the rows, never from the model. Asked to tally its own table it
 * reported "1 partial, 1 missing" for a table holding 2 partial and 0 missing —
 * arithmetic is not a job to delegate when the data is right there.
 */
export function summariseRequirements(requirements = []) {
  const req = requirements.filter((r) => r.kind === "required");
  const n = (rows, v) => rows.filter((r) => r.verdict === v).length;
  const parts = [`Meets ${n(req, "met")} of ${req.length} required`];
  if (n(req, "partial")) parts.push(`${n(req, "partial")} partial`);
  if (n(req, "missing")) parts.push(`${n(req, "missing")} missing`);
  const pref = requirements.filter((r) => r.kind !== "required");
  if (pref.length) parts.push(`${n(pref, "met")} of ${pref.length} preferred`);
  return parts.join(" · ");
}

export function renderKit(job, kit, meta) {
  const L = [];
  L.push(`# ${job.title}`);
  L.push(`**${job.company}** · ${job.location || "location not stated"}${job.salaryText ? ` · ${job.salaryText}` : ""}`);
  L.push(`Score ${job.score}${job.ageDays !== null ? ` · posted ${job.ageDays}d ago` : ""} · <${job.url}>`);
  if (job.reason) L.push(`\n> ${job.reason}`);
  if (job.against) L.push(`>\n> **Against:** ${job.against}`);

  L.push(`\n---\n\n## Requirements audit\n`);
  L.push(`**${summariseRequirements(kit.requirements)}**\n`);
  const icon = { met: "✓", partial: "~", missing: "✗" };
  L.push(`| | Requirement | | Evidence |`);
  L.push(`|---|---|---|---|`);
  for (const r of kit.requirements) {
    const k = r.kind === "required" ? "**req**" : "pref";
    L.push(`| ${icon[r.verdict] ?? "?"} | ${String(r.requirement).replace(/\|/g, "\\|")} | ${k} | ${String(r.evidence).replace(/\|/g, "\\|")} |`);
  }

  L.push(`\n---\n\n## Cover letter\n`);
  L.push(kit.cover_letter.trim());

  L.push(`\n---\n\n## CV bullets — in this order for this role\n`);
  kit.cv_bullets.forEach((b, i) => {
    L.push(`${i + 1}. ${b.bullet}`);
    L.push(`   <sub>${b.rationale}</sub>\n`);
  });

  L.push(`---\n\n## Application form answers\n`);
  kit.answers.forEach((a) => {
    L.push(`**${a.question}**\n`);
    L.push(`${a.answer}\n`);
  });

  L.push(`---\n\n## Gaps — prep these before an interview\n`);
  kit.gaps.forEach((g) => L.push(`- ${g.gap}`));

  L.push(`\n---\n\n## Questions to ask them\n`);
  kit.questions_to_ask.forEach((q) => L.push(`- ${q.question}`));

  L.push(`\n---\n`);
  L.push(`<sub>Drafted by ${meta.model} · ${meta.date} · review before sending — nothing here has been submitted.</sub>`);
  L.push(`<sub>When you send it: \`node bin/shortlist.js mark ${job.id} applied\`</sub>`);
  return L.join("\n");
}

export function writeKit(job, markdown) {
  const dir = path.join(process.cwd(), "data", "applications");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${slug(job.company)}-${slug(job.title)}-${job.id.slice(0, 8)}.md`);
  fs.writeFileSync(file, markdown);
  return file;
}
