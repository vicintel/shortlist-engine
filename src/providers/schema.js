/**
 * Structured-output contracts, defined once in a neutral shape. Each provider
 * adapter translates them into whatever that vendor calls structured output.
 *
 * A field is { type, desc }, where type is "string" | "integer" | "array".
 * An array field carries `items`, itself a field map, giving an array of objects.
 */

export const SCORE_FIELDS = {
  score: { type: "integer", desc: "Overall fit, 0-100. Be strict: 70+ means genuinely worth applying to." },
  domain_fit: { type: "integer", desc: "0-25. Payments, fintech, commerce, logistics, or African/emerging markets." },
  stack_fit: { type: "integer", desc: "0-25. JavaScript, Node, React/Next.js, MongoDB, REST APIs, webhooks." },
  seniority_fit: { type: "integer", desc: "0-15. Mid to senior individual contributor. Penalise staff, principal and management." },
  location_fit: { type: "integer", desc: "0-20. Can someone based in Lagos, Nigeria hold this role without visa sponsorship?" },
  signal_quality: { type: "integer", desc: "0-15. Clear description, real product, compensation transparency, named company." },
  reason: { type: "string", desc: "One sentence, at most 25 words, on why this is or is not a fit. Concrete, not generic." },
  against: { type: "string", desc: "The single strongest reason he might not get this role, or would be unhappy in it. Blunt. Empty string only if there genuinely is none." },
  seniority_label: { type: "string", desc: "One of: junior, mid, senior, staff+, lead/manager, unclear." },
  remote_policy: { type: "string", desc: "One of: global, regional, country-locked, onsite, unclear." },

  // `score` answers "would he want this". These answer "would they hire him". They
  // are close to uncorrelated in practice: the lowest-scoring role in the first batch
  // was the one he met the most requirements for. Ranking on fit alone sends him at
  // the jobs he is least likely to get.
  odds: {
    type: "integer",
    desc: "0-100: the realistic chance THIS employer would make HIM an offer, ignoring whether he'd enjoy it. Anchor it: 0-20 he cannot legally be hired or misses most requirements; 20-40 eligible but a stretch; 40-60 a credible applicant among many; 60-80 meets nearly everything and is clearly hireable from Nigeria; 80+ they would struggle to find a better-matched applicant. Most honest scores sit between 15 and 50. Do not be kind — a flattering number costs him a week of work.",
  },
  eligibility: {
    type: "string",
    desc: "Exactly one of: names-nigeria (the posting or company explicitly lists Nigeria or Africa as somewhere they hire), worldwide (hires anywhere, no country list), eor (says they employ through an EOR, PEO, Deel, Remote.com, Oyster or 'employer of record'), contractor (open to contractors regardless of country), silent (says remote but never says where they can employ), excluded (names countries and Nigeria is not among them). This single field is the biggest driver of odds — most technically perfect roles die here.",
  },
  odds_reason: {
    type: "string",
    desc: "One sentence, at most 25 words, on the main thing that decides whether he gets it. Name the blocker if there is one.",
  },
  requirements_met: {
    type: "string",
    desc: "Rough count of stated REQUIRED items he clearly meets, as 'n of m', judged from the posting. Estimate honestly; do not inflate.",
  },
};

export const APPLY_FIELDS = {
  cover_letter: {
    type: "string",
    desc: "150-220 words. Open with the single most relevant thing he has built for THIS role, named specifically. No 'I am writing to apply for'. No 'passionate'. No restating the job description back at them. Plain sentences, British spelling, first person. End with one concrete line about what he would want to work on there.",
  },
  requirements: {
    type: "array",
    desc: "EVERY distinct requirement the posting states — do not summarise or merge them, and do not invent any that are not written there. Work through the requirements, qualifications and responsibilities sections line by line. Typically 8-16 items.",
    items: {
      requirement: { type: "string", desc: "The requirement, in the posting's own words, condensed to one line." },
      kind: { type: "string", desc: "Exactly one of: required, preferred." },
      verdict: { type: "string", desc: "Exactly one of: met, partial, missing. Be strict — 'adjacent experience' is partial, not met." },
      evidence: { type: "string", desc: "For met/partial: the specific thing of his that satisfies it, named. For missing: what he would have to learn or claim, and the nearest genuine substitute. Under 25 words." },
    },
  },
  cv_bullets: {
    type: "array",
    desc: "Exactly 5 CV bullets, reordered and reworded so the most relevant to THIS posting is first. Each must be traceable to his real evidence — never invent a system, a number, or a technology.",
    items: {
      bullet: { type: "string", desc: "The bullet as it should appear on the CV. Lead with the outcome, keep the real figure if there is one." },
      rationale: { type: "string", desc: "Under 15 words: which line of the posting this answers." },
    },
  },
  answers: {
    type: "array",
    desc: "Drafts for 5 to 7 application-form questions this employer is likely to ask, including any custom question visible in the posting. Always include work authorisation and location/timezone. Answer as him, in first person, ready to paste.",
    items: {
      question: { type: "string", desc: "The question as an ATS form would phrase it." },
      answer: { type: "string", desc: "His answer. 40-90 words. Specific and honest — never claim work authorisation he does not have." },
    },
  },
  gaps: {
    type: "array",
    desc: "2 to 4 things this posting asks for that his background does not clearly cover. Blunt and useful — this is interview prep, not reassurance.",
    items: { gap: { type: "string", desc: "What is missing, and the nearest genuine thing he has instead." } },
  },
  questions_to_ask: {
    type: "array",
    desc: "3 questions for HIM to ask THEM, specific to this company and role. Questions that show he read the posting and understands the domain — not 'what does a typical day look like'.",
    items: { question: { type: "string", desc: "The question." } },
  },
};

const G = { string: "STRING", integer: "INTEGER", array: "ARRAY" };

/** Google's OpenAPI-subset dialect: uppercase types, no additionalProperties. */
export function toGoogle(fields) {
  const properties = {};
  for (const [k, f] of Object.entries(fields)) {
    if (f.type === "array") {
      properties[k] = {
        type: "ARRAY",
        description: f.desc,
        items: { type: "OBJECT", properties: mapGoogleProps(f.items), required: Object.keys(f.items) },
      };
    } else {
      properties[k] = { type: G[f.type], description: f.desc };
    }
  }
  return { type: "OBJECT", properties, required: Object.keys(fields) };
}

const mapGoogleProps = (items) =>
  Object.fromEntries(Object.entries(items).map(([k, f]) => [k, { type: G[f.type], description: f.desc }]));

/** JSON Schema (Anthropic, OpenAI-compatible). */
export function toJSONSchema(fields) {
  const properties = {};
  for (const [k, f] of Object.entries(fields)) {
    if (f.type === "array") {
      const props = Object.fromEntries(Object.entries(f.items).map(([ik, if_]) => [ik, { type: if_.type, description: if_.desc }]));
      properties[k] = {
        type: "array",
        description: f.desc,
        items: { type: "object", properties: props, required: Object.keys(f.items), additionalProperties: false },
      };
    } else {
      properties[k] = { type: f.type, description: f.desc };
    }
  }
  return { type: "object", properties, required: Object.keys(fields), additionalProperties: false };
}

/** Guard against a model returning a plausible shape with nonsense in it. */
export function validateScore(v) {
  if (!v || typeof v !== "object") throw new Error("verdict is not an object");
  for (const k of Object.keys(SCORE_FIELDS)) if (!(k in v)) throw new Error(`missing field: ${k}`);
  const n = Number(v.score);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error(`score out of range: ${v.score}`);
  const o = Number(v.odds);
  if (!Number.isFinite(o) || o < 0 || o > 100) throw new Error(`odds out of range: ${v.odds}`);
  return {
    ...v,
    score: Math.round(n),
    odds: Math.round(o),
    reason: String(v.reason ?? "").trim(),
    against: String(v.against ?? "").trim(),
    odds_reason: String(v.odds_reason ?? "").trim(),
  };
}

export function validateApply(v) {
  if (!v || typeof v !== "object") throw new Error("kit is not an object");
  if (!v.cover_letter || v.cover_letter.length < 200) throw new Error("cover letter missing or too short");
  for (const k of ["requirements", "cv_bullets", "answers", "gaps", "questions_to_ask"]) {
    if (!Array.isArray(v[k]) || !v[k].length) throw new Error(`${k} missing or empty`);
  }
  return v;
}
